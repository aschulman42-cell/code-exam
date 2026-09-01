/**
 * argparse.js - Minimal argument parser for code-exam CLI.
 *
 * Zero dependencies. Mimics Python argparse behavior:
 *   --flag            -> args.flag = true
 *   --option VALUE    -> args.option = VALUE
 *   --option=VALUE    -> args.option = VALUE
 *   --multi VAL1 VAL2 -> args.multi = [VAL1, VAL2]  (for declared list args)
 *
 * Supports --help, --version, and optional-value arguments.
 */

import { readFileSync } from 'node:fs';
import { resolveProvider } from './core/providers.js';

// Version display (major.minor) sourced from package.json — single source of
// truth, so it auto-tracks bumps. Fallback covers a bundled/standalone build
// where package.json isn't on disk.
let VERSION = '0.5';
try {
  const _pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  VERSION = _pkg.version.split('.').slice(0, 2).join('.');
} catch { /* keep fallback */ }

// The product banner — shown on --help / --version / bare invocation / cmdline
// error (everywhere except real command output). Single source for the text.
const BANNER = `CodeExam -- GUI, CLI, and MCP tools for examining source-code and quasi-source, with AI features
Version: ${VERSION}
https://github.com/aschulman42-cell/code-exam`;

export function printBanner(stream = process.stdout) {
  stream.write(BANNER + '\n');
}


/**
 * Levenshtein edit distance, capped early once it exceeds `max` (returns
 * max+1 in that case). Small two-row implementation — adequate for the
 * short option strings we compare. #69.
 */
function _levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Find the alias closest to an unknown token (edit distance <= 2), for a
 * "Did you mean '--files'?" hint. Returns the closest alias string or null.
 * #69.
 */
function suggestClosest(token, aliasMap) {
  let best = null;
  let bestDist = 3; // only suggest within distance 2
  for (const alias of aliasMap.keys()) {
    const d = _levenshtein(token, alias, 2);
    if (d < bestDist) { bestDist = d; best = alias; }
  }
  return best;
}


/**
 * Parse process.argv and return a normalized args object.
 * @returns {object}
 */
export function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {
    // Index management
    build_index: null,
    rebuild_functions: false,
    build_rename_map: false,
    rename_min_lines: 0,
    file_bookends: null,
    bundle_seams: null,
    seam_verbose: false,
    digest: null,
    index_path: '.code_search_index',
    port: null,
    multi_index: null,
    skip_semantic: true,
    use_tree_sitter: false,
    extensions: null,
    exclude_extensions: null,
    add_extensions: null,
    demangler: null,

    // Search
    search: null,
    literal: null,
    fast: null,
    regex: null,
    files_search: null,
    folders_search: null,

    // Browse
    stats: false,
    list_files: null,
    show_file: null,
    list_functions: null,
    list_functions_alpha: false,
    list_functions_size: false,
    extract: null,
    scan_extensions: null,
    index_extensions: false,
    overview: false,
    overview_by_ai: false,
    cpu: false,           // --overview-by-ai: force local GGUF onto CPU (skip GPU)
    grounding: null,      // --overview-by-ai: grounded (default) | augmented | attributed
    cost: false,          // --overview-by-ai: explicit "show cost" (default; affirmation only)
    no_cost: false,       // --overview-by-ai: suppress the cost/usage line (default: shown)
    max_budget_usd: null, // --overview-by-ai (claude engine): hard spend cap; also CE_OVERVIEW_MAX_BUDGET env
    context_size: null,   // --overview-by-ai (local engine): preferred GGUF context (#276); same name as server.js's flag
    flash_attention: false, // local GGUF: createContext({flashAttention}); OFF by default (experimental in node-llama-cpp 3.18.1)
    live_today_date: false, // local GGUF: let node-llama-cpp inject the live date; OFF by default (F58 — a code index has no 'today')
    list_indexes: null,

    // Callers / Callees
    callers: null,
    callees: null,
    most_called: null,
    depth: null,
    min_name_length: 1,
    include_macros: false,
    defined_only: false,
    exclude_tests: false,

    // Graph
    call_tree: null,
    class_tree: null,
    file_map: null,
    file_tree: null,
    mermaid: false,

    // Display modifiers
    max_results: 20,
    timeout: null,        // minutes; currently consumed by --overview-by-ai
    context: 3,
    verbose: false,
    full_path: false,
    bare: false,
    provenance: false,
    filter: null,
    no_tests: false,
    emit_harness: null,
    harness_template: null,
    harness_out: null,
    synthetic_loader: false,
    list_harnessable: false,
    census_imports: false,
    exports: null,
    imports_from: null,
    imports: null,
    infrastructure: false,
    emit_catalog: null,
    catalog_replace: false,
    used_by: null,
    include_path: null,
    top_n: null,
    neighbourhood: null,
    exclude_path: null,
    dedup: 'exact',
    min_terms: '0',
    match_renames: false,
    sort: null,           // sort mode for --functions / --files etc. ('alpha' | 'size' | null)

    // Interactive
    interactive: false,

    // Phase 2: Callers/callees/graph
    callers: null,
    callees: null,
    most_called: null,
    call_tree: null,
    class_tree: null,
    call_inventory: null,
    file_map: null,
    file_tree: null,
    depth: null,
    mermaid: false,
    min_name_length: 1,
    include_macros: false,
    defined_only: false,
    exclude_tests: false,

    // Phase 3: Metrics/discovery
    hotspots: null,
    hot_folders: null,
    entry_points: null,
    max_calls: 0,
    gaps: null,
    domain_fns: null,
    list_classes: false,
    data_structs: false,
    client_server: false,
    referenced_resources: null,
    list_models: false,
    list_artifacts: false,
    list_kernels: false,
    list_multimodal: false,
    list_post_training: false,
    list_reasoning: false,
    list_datasets: false,
    list_training: false,
    list_inference: false,
    list_llm_calls: false,
    list_tools: false,
    list_chains: false,
    list_embeddings: false,
    list_structured_output: false,
    list_models_used: false,
    list_pipelines: false,
    list_explainability: false,
    class_hotspots: null,
    discover_vocabulary: null,
    multisect_search: null,
    vocab_in: null,
    show_dupes: false,
    full_path: false,
    bare: false,
    provenance: false,
    dedup: 'exact',

    // Phase 8a: Claim search (LLM-based term extraction)
    claim_search: null,
    claim_file: null,
    claim_number: null,      // --claim-number <n>: which claim of a multi-claim input --claim-search / --claim-analyze use (#311 step 3)
    use_claude: false,
    air_gapped: false,      // #223: block all cloud AI calls this run
    allow_connected: false, // #223: keep the block active on a connected machine
    llm: null,            // canonical: --llm <provider>; provider name ('claude', etc.)
    api_key: null,
    claim_model: null,
    model: null,          // canonical: --model <path>; unifies --claim-model + --analyze-model
    claude_model: null,   // Claude API model id (e.g. claude-sonnet-4-6); distinct from --model (GGUF)
    temperature: 0.0,
    show_prompt: false,
    vocab_tight: false,
    no_claim_filter: false,
    no_vocabulary: false,

    // Phase 8b: LLM analysis
    analyze: null,
    claim_analyze: null,
    claim_chart: null,
    targets: null,
    elements: null,
    granularity: 'fine',     // --granularity coarse|fine: how --claim-* commands split a claim into rows (A14)
    no_callees: false,
    scope_note: null,
    targets_note: null,
    targets_out: null,
    targets_per_element: null,
    max_retrieved_targets: null,
    claim_locate: null,
    no_refine: false,
    no_navigate: false,
    blind: false,
    include_tests: false,
    include_op: false,       // --include-op: admit .op pseudo-source (binstrings dumps) as retrieval candidates
    propose_from_priors: false,
    hunt: false,
    no_hunt: false,
    synonymize: null,        // HOF-b: rewrite a claim's wording away from code vocabulary
    synonymize_out: null,
    claims_per_line: false,  // force the corpus reading; --single-claim forces the other
    single_claim: false,
    claims_only: null,       // --pseudo-claims: machine-readable claims + anchors sidecar
    per_element_select: false,
    runs: null,              // --claim-locate: repeat discovery+selection N times, union targets
    verdicts_out: null,      // --claim-chart: dump per-target verdicts for offline merge replay
    no_per_element: false,   // --claim-analyze: skip the per-element search arm
    per_element_n: null,     // --claim-analyze: per-element budget (default 1/element)
    hunt_rounds: null,
    hunt_calls: null,
    claims_loop: null,
    loop_k: null,
    sponge_t: null,
    loop_save_analyses: false,
    loop_redraft: false,
    multisect_analyze: null,
    file_analyze: null,
    analyze_model: null,
    analyze_context: null,
    mask_all: false,
    line_numbers: false,
    no_line_numbers: false,
    force: false,         // --analyze/--file-analyze: bypass the projected-cost guard
    claim_text: null,
    with_digest: false,

    // Phase 9: Extended extraction
    follow_calls: false,
    deep: null,
    comments_only: false,

    // Phase 4: Dedup
    dupefiles: null,
    func_dupes: null,
    near_dupes: null,
    struct_dupes: null,
    show_funcstring: null,
    struct_diff: null,
    struct_diff_all: null,
    show_sources: false,
    cross_source_only: false,
    string_call_dupes: null,
    string_call_diff_all: null,
    cmp_string_call_dupes: null,
    notable_funcstr_matches: null,
    nf_min_lines: null,
    nf_min_surprise: null,
    nf_sort: null,
    nf_tight: false,
    funcstr_hashes: null,
    funcstr_corpus: null,
    exclude_corpus: null,
    fc_common_df: null,
    fc_rare_df: null,
    fh_tight: false,
    fingerprint_min_tokens: null,
    fingerprint_work: null,
    fingerprint_ref: null,
    show_tokens: false,
    build_fp_renames: null,
    dry_run: false,
    candidates: null,
    ground_truth: null,
    group_by: null,
    group_max: null,     // --group-max: split candidate groups larger than this (0 = never)
    include_vendored: false, // --include-vendored: keep detected third-party subtrees as candidates
    file_seed: false,        // --file-seed: per-file groups for ALL files under the size cap (the pre-2026-08-29 opt-in behaviour)
    no_file_seed: false,     // --no-file-seed: no per-file groups at all. Absent both: files with a doc header seed a group (default)
    use_docs: false,      // --candidates: include TEXT_EXTENSIONS docs in the gather vocabulary (#284 signal-rich gather)
    catalog_seed: false,
    no_catalog_seed: false,  // --no-catalog-seed: opt OUT of the command-catalog seed (now default ON)
    catalog_max: null,       // --catalog-max <n>: cap [cmd] groups (0 = uncapped)  // --candidates: seed groups from command-catalog handler joins (#284 signal-rich gather)
    literal_seed: false,  // --candidates: seed groups from rare shared string literals (#289)
    body_match_seed: false, // --candidates: body-containment rescue for name-match-failed cutoff tokens (#289)
    min_rank: null,       // --pseudo-claims: draft-time floor over [P..] rank tags (default P2 when tags present)
    shape_profile: 'litigated', // --pseudo-claims: which claim population the draft should resemble (litigated|ai-ml|randpat)
    doc_anchors: false,   // --candidates: attach best-matching doc sections as path@L anchors (#289 enrichment)
    rank: false,
    include_evidence_pack: false,
    pseudo_claims_chart: false,
    fp_classes: false,
    save_fingerprints: null,
    load_fingerprints: null,  // populated as array by 'list' parser
    clean_fp: false,

    // Content analysis
    command_catalog: false,
    string_table: null,
    breadcrumbs: false,
    prompt_catalog: false,
    no_rename: false,

    // Binary-bundled-JS extraction (#74)
    extract_js_from_binary: null,
    output_dir: null,

    // Binary inspection (#77)
    inspect_binary: null,

    // Bundle-seam splitting at index time (#20)
    split_bundle: false,

    // Track which flags were explicitly set (for dispatch logic)
    _explicit: new Set(),

    // Unknown -prefixed tokens (typos). The dispatcher uses this to avoid
    // silently dropping into the REPL on a mistyped flag. #69.
    _unknownFlags: [],
    // Unexpected bare positionals (e.g. `ce foobar`). Same treatment as unknown
    // flags — reported + exit 2 before the index load. #69.
    _unknownPositionals: [],
  };

  // Definitions: [argName, type, aliases]
  // type: 'flag', 'value', 'optional_value', 'list'
  const defs = [
    ['build_index',          'value',          ['--build-index']],
    ['rebuild_functions',    'flag',           ['--rebuild-functions']],
    ['build_rename_map',     'flag',           ['--build-rename-map']],
    // #247/#249: recognized so the pre-parse GUI launch path can validate flags
    // and distinguish `--tour` used as a flag from `--tour` used as a value.
    ['gui',                  'flag',           ['--gui']],
    ['tour',                 'flag',           ['--tour']],
    ['rename_min_lines',     'int',            ['--rename-min-lines']],
    ['file_bookends',        'optional_value', ['--file-bookends']],
    ['bundle_seams',         'optional_value', ['--bundle-seams']],
    ['seam_verbose',         'flag',           ['--seam-verbose']],
    ['digest',               'value',          ['--digest']],
    ['index_path',           'value',          ['--index-path', '--load-index']],
    ['port',                 'value',          ['--port']],
    ['multi_index',          'value',          ['--multi-index']],
    ['skip_semantic',        'flag',           ['--skip-semantic']],
    ['use_tree_sitter',      'flag',           ['--use-tree-sitter']],
    ['extensions',           'value',          ['--extensions']],
    ['exclude_extensions',   'value',          ['--exclude-extensions']],
    ['add_extensions',       'value',          ['--add-extensions']],
    ['demangler',            'value',          ['--demangler']],

    ['search',               'value',          ['--search']],
    ['literal',              'value',          ['--literal']],
    ['fast',                 'value',          ['--fast']],
    ['regex',                'value',          ['--regex']],
    ['files_search',         'value',          ['--files-search']],
    ['folders_search',       'value',          ['--folders-search']],

    ['stats',                'flag',           ['--stats']],
    ['list_files',           'optional_value', ['--files'], ['--list-files']],
    ['show_file',            'value',          ['--show-file']],
    ['list_functions',       'optional_value', ['--functions'], ['--list-functions']],
    ['list_functions_alpha', 'flag',           [], ['--list-functions-alpha']],
    ['list_functions_size',  'flag',           [], ['--list-functions-size']],
    ['extract',              'value',          ['--extract']],
    ['scan_extensions',      'value',          ['--scan-extensions']],
    ['index_extensions',     'flag',           ['--index-extensions']],
    ['overview',             'flag',           ['--overview']],
    ['overview_by_ai',       'flag',           ['--overview-by-ai', '--overview-by-AI']],
    ['context_size',         'int',            ['--context-size']],
    ['flash_attention',      'flag',           ['--flash-attention']],
    ['live_today_date',      'flag',           ['--live-today-date']],
    ['cpu',                  'flag',           ['--cpu']],
    ['grounding',            'value',          ['--grounding']],
    ['cost',                 'flag',           ['--cost']],
    ['no_cost',              'flag',           ['--no-cost']],
    ['max_budget_usd',       'value',          ['--max-budget-usd']],
    ['list_indexes',         'optional_value', ['--indexes'], ['--list-indexes']],

    ['max_results',          'int',            ['--max-results', '--max', '-n']],
    ['timeout',              'int',            ['--timeout']],
    ['context',              'int',            ['--context']],
    ['verbose',              'flag',           ['--verbose', '-v']],
    ['full_path',            'flag',           ['--full-path']],
    ['filter',               'value',          ['--filter']],
    ['include_path',         'list',           ['--include-path']],
    ['top_n',                'value',          ['--top-n']],
    ['neighbourhood',        'value',          ['--neighbourhood', '--neighborhood']],
    ['exclude_path',         'list',           ['--exclude-path']],
    ['dedup',                'value',          ['--dedup']],
    ['min_terms',            'value',          ['--min-terms']],
    ['match_renames',        'flag',           ['--match-renames']],
    ['sort',                 'value',          ['--sort']],

    ['interactive',          'flag',           ['--interactive', '-i']],

    // Phase 2: callers/callees/graph
    ['callers',              'value',          ['--callers']],
    ['callees',              'value',          ['--callees']],
    ['most_called',          'int',            ['--most-called']],
    ['depth',                'int',            ['--depth']],
    ['min_name_length',      'int',            ['--min-name-length']],
    ['include_macros',       'flag',           ['--include-macros']],
    ['defined_only',         'flag',           ['--defined-only']],
    ['exclude_tests',        'flag',           ['--exclude-tests']],
    ['no_tests',             'flag',           ['--no-tests']],
    ['emit_harness',         'value',          ['--emit-harness']],
    ['harness_template',     'value',          ['--harness-template']],
    ['harness_out',          'value',          ['--out', '--harness-out']],
    ['synthetic_loader',     'flag',           ['--synthetic-loader']],
    ['list_harnessable',     'flag',           ['--list-harnessable']],
    ['census_imports',       'flag',           ['--census-imports']],
    ['exports',              'optional_value', ['--exports']],
    ['imports_from',         'value',          ['--imports-from']],
    ['imports',              'value',          ['--imports']],
    ['infrastructure',       'flag',           ['--infrastructure', '--infra']],
    ['emit_catalog',         'value',          ['--emit-catalog']],
    ['catalog_replace',      'flag',           ['--catalog-replace']],
    ['used_by',              'value',          ['--used-by']],
    ['call_tree',            'value',          ['--call-tree']],
    ['class_tree',           'optional_value', ['--class-tree']],
    ['call_inventory',       'optional_value', ['--call-inventory']],
    ['file_map',             'optional_value', ['--file-map']],
    ['file_tree',            'value',          ['--file-tree']],
    ['mermaid',              'flag',           ['--mermaid']],

    // Phase 3: metrics/discovery
    ['hotspots',             'int',            ['--hotspots']],
    ['hot_folders',          'int',            ['--hot-folders']],
    ['entry_points',         'int',            ['--entry-points']],
    ['max_calls',            'int',            ['--max-calls']],
    ['gaps',                 'optional_value', ['--gaps']],
    ['domain_fns',           'int',            ['--domain-fns']],
    ['list_classes',         'flag',           ['--classes'], ['--list-classes']],
    ['data_structs',         'flag',           ['--data-structs'], ['--structs']],
    ['client_server',        'flag',           ['--client-server'], ['--routes']],
    ['referenced_resources', 'optional_value', ['--referenced-resources', '--resources']],
    ['list_models',          'flag',           ['--models'], ['--list-models']],
    ['list_artifacts',       'flag',           ['--artifacts'], ['--list-artifacts']],
    ['list_kernels',         'flag',           ['--kernels'], ['--list-kernels']],
    ['list_multimodal',      'flag',           ['--multimodal', '--vision'], ['--list-multimodal']],
    ['list_datasets',        'flag',           ['--datasets'], ['--list-datasets']],
    ['list_training',        'flag',           ['--training'], ['--list-training']],
    ['list_post_training',   'flag',           ['--post-training', '--finetuning'], ['--list-post-training']],
    ['list_reasoning',       'flag',           ['--reasoning'], ['--list-reasoning']],
    ['list_inference',       'flag',           ['--inference'], ['--list-inference']],
    ['list_llm_calls',       'flag',           ['--llm-calls'], ['--list-llm-calls']],
    ['list_tools',           'flag',           ['--tools'], ['--list-tools']],
    ['list_chains',          'flag',           ['--chains'], ['--list-chains', '--agents']],
    ['list_embeddings',      'flag',           ['--embeddings'], ['--list-embeddings', '--vectors']],
    ['list_structured_output', 'flag',         ['--structured-output'], ['--schemas', '--list-structured-output']],
    ['list_models_used',     'flag',           ['--models-used'], ['--list-models-used']],
    ['list_pipelines',       'flag',           ['--pipelines'], ['--list-pipelines', '--workflows']],
    ['list_explainability',  'flag',           ['--explainability'], ['--list-explainability', '--analysis']],
    ['class_hotspots',       'int',            ['--class-hotspots']],
    ['discover_vocabulary',  'int',            ['--vocabulary', '--vocab'], ['--discover-vocabulary']],
    ['multisect_search',     'value',          ['--multisect-search', '--multisect']],
    ['vocab_in',             'value',          ['--in']],
    ['bare',                 'flag',           ['--bare']],
    ['provenance',           'flag',           ['--provenance']],
    ['show_dupes',           'flag',           ['--show-dupes']],

    // Phase 8a: claim search
    ['claim_search',         'value',          ['--claim-search']],
    ['claim_file',           'value',          ['--claim-file']],
    ['claim_number',         'value',          ['--claim-number']],
    // issue-311-dep-claim-chart: chart claim 1 and every dependent beneath it.
    ['claim_family',         'flag',           ['--claim-family']],
    // #281: pseudo-claim generation (v1: explicit anchors)
    ['pseudo_claims',        'optional_value', ['--pseudo-claims']],
    ['pseudo_out',           'value',          ['--pseudo-out']],
    // #284 B1: --pseudo-claims --candidates <path> emits an UNRANKED mechanism
    // candidate anchors.lst (mechanism-grouper) instead of drafting.
    ['candidates',           'value',          ['--candidates']],
    ['ground_truth',         'value',          ['--ground-truth']],
    ['group_by',             'value',          ['--group-by']],
    ['group_max',            'int',            ['--group-max']],
    ['include_vendored',     'flag',           ['--include-vendored']],
    ['file_seed',            'flag',           ['--file-seed']],
    ['no_file_seed',         'flag',           ['--no-file-seed']],
    ['use_docs',             'flag',           ['--use-docs']],
    ['catalog_seed',         'flag',           ['--catalog-seed']],
    ['no_catalog_seed',      'flag',           ['--no-catalog-seed']],
    ['catalog_max',          'int',            ['--catalog-max']],
    ['literal_seed',         'flag',           ['--literal-seed']],
    ['body_match_seed',      'flag',           ['--body-match-seed']],
    ['min_rank',             'value',          ['--min-rank']],
    ['shape_profile',        'value',          ['--shape-profile']],
    ['doc_anchors',          'flag',           ['--doc-anchors']],
    ['rank',                 'flag',           ['--rank']],
    ['include_evidence_pack', 'flag',          ['--include-evidence-pack']],
    ['pseudo_claims_chart',  'flag',           ['--pseudo-claims-chart']],
    // HOF: the machine-readable sibling of the human artifact. One claim per
    // line plus an anchors sidecar, so the claims feed straight into
    // --synonymize and the grounded anchors survive as a scoreable answer key.
    ['claims_only',          'value',          ['--claims-only']],
    // pseudo-claim-triage: deterministic first cut over a claims sidecar; needs
    // no index, no model. Writes <base>_triage.md and <base>_keep.txt.
    ['triage',               'value',          ['--triage']],
    ['dry_run',              'flag',           ['--dry-run']],
    ['use_claude',           'flag',           [], ['--use-claude']],
    ['llm',                  'value',          ['--llm']],
    ['openai_key',           'value',          ['--openai-key']],
    ['openai_model',         'value',          ['--openai-model']],
    ['gemini_key',           'value',          ['--gemini-key']],   // #246
    ['gemini_model',         'value',          ['--gemini-model']],
    ['air_gapped',           'flag',           ['--air-gapped']],
    ['allow_connected',      'flag',           ['--allow-connected']],
    ['api_key',              'value',          ['--api-key']],
    ['model',                'value',          ['--model']],
    ['claude_model',         'value',          ['--claude-model']],
    ['claim_model',          'value',          [], ['--claim-model', '--term-extract-model']],
    ['temperature',          'float',          ['--temperature']],
    ['show_prompt',          'flag',           ['--show-prompt']],
    ['vocab_tight',          'flag',           ['--vocab-tight']],
    ['no_claim_filter',      'flag',           ['--no-claim-filter']],
    ['no_vocabulary',        'flag',           ['--no-vocabulary', '--no-vocab']],

    // Phase 8b: LLM analysis
    ['analyze',              'value',          ['--analyze']],
    ['claim_analyze',        'value',          ['--claim-analyze']],
    ['claim_chart',          'value',          ['--claim-chart']],
    ['targets',              'value',          ['--targets']],
    ['elements',             'value',          ['--elements']],
    ['granularity',          'value',          ['--granularity']],
    ['no_callees',           'flag',           ['--no-callees']],
    ['scope_note',           'value',          ['--scope-note']],
    ['targets_note',         'value',          ['--targets-note']],
    ['targets_out',          'value',          ['--targets-out']],
    ['targets_per_element',  'value',          ['--targets-per-element']],
    // chart-retrieval-whole-claim-arm: targets from the claim's own words, on
    // top of the per-element budget; 0 disables.
    ['whole_claim_targets',  'int',            ['--whole-claim-targets']],
    ['no_dep_synonyms',      'flag',           ['--no-dep-synonyms']],
    // chart-retrieval-content-arm-and-budget: targets added when 2+ elements'
    // top candidates share a file that contributed none; 0 disables.
    ['concentration_targets', 'int',           ['--concentration-targets']],
    ['max_retrieved_targets', 'value',         ['--max-retrieved-targets']],
    ['claim_locate',         'value',          ['--claim-locate']],
    ['no_refine',            'flag',           ['--no-refine']],
    ['no_navigate',          'flag',           ['--no-navigate']],
    ['blind',                'flag',           ['--blind']],
    ['include_tests',        'flag',           ['--include-tests']],
    ['include_op',           'flag',           ['--include-op']],
    ['propose_from_priors',  'flag',           ['--propose-from-priors']],
    ['hunt',                 'flag',           ['--hunt']],
    ['no_hunt',              'flag',           ['--no-hunt']],
    ['synonymize',           'value',          ['--synonymize']],
    ['synonymize_out',       'value',          ['--synonymize-out']],
    // Force the one-claim-per-line reading on a file that carries no format
    // marker (hand-made corpora). --single-claim forces the other way, for a
    // one-line claim that would otherwise be auto-detected as a corpus of one.
    ['claims_per_line',      'flag',           ['--claims-per-line']],
    ['single_claim',         'flag',           ['--single-claim']],
    ['per_element_select',   'flag',           ['--per-element-select']],
    ['runs',                 'int',            ['--runs']],
    ['verdicts_out',         'value',          ['--verdicts-out']],
    ['no_per_element',       'flag',           ['--no-per-element']],
    ['per_element_n',        'int',            ['--per-element-n']],
    ['hunt_rounds',          'int',            ['--hunt-rounds']],
    ['hunt_calls',           'int',            ['--hunt-calls']],
    ['claims_loop',          'value',          ['--claims-loop']],
    ['loop_k',               'value',          ['--loop-k']],
    ['sponge_t',             'value',          ['--sponge-t']],
    ['loop_save_analyses',   'flag',           ['--loop-save-analyses']],
    ['loop_redraft',         'flag',           ['--loop-redraft']],
    ['multisect_analyze',    'value',          ['--multisect-analyze']],
    ['file_analyze',         'value',          ['--file-analyze']],
    ['analyze_model',        'value',          [], ['--analyze-model']],
    ['analyze_context',      'value',          ['--with', '--context-text']],
    ['mask_all',             'flag',           ['--mask-all']],
    ['line_numbers',         'flag',           ['--line-numbers']],
    ['no_line_numbers',      'flag',           ['--no-line-numbers']],
    ['force',                'flag',           ['--force']],
    ['claim_text',           'value',          ['--claim-text']],
    ['with_digest',          'flag',           ['--with-digest']],

    // Phase 9: Extended extraction
    ['follow_calls',         'flag',           [], ['--follow-calls']],
    ['deep',                 'optional_value', ['--deep']],
    ['comments_only',        'optional_value', ['--comments-only']],

    // Phase 4: dedup
    ['dupefiles',            'int',            ['--dupefiles']],
    ['func_dupes',           'int',            ['--func-dupes']],
    ['near_dupes',           'int',            ['--near-dupes']],
    ['struct_dupes',         'int',            ['--struct-dupes']],
    ['show_funcstring',      'optional_value', ['--show-funcstring']],
    ['struct_diff',          'value',          ['--struct-diff']],
    ['struct_diff_all',      'int',            ['--struct-diff-all']],
    ['show_sources',         'flag',           ['--show-sources']],
    ['cross_source_only',    'flag',           ['--cross-source-only']],
    ['string_call_dupes',    'int',            ['--string-call-dupes']],
    ['string_call_diff_all', 'int',            ['--string-call-diff-all']],
    ['cmp_string_call_dupes','value',          ['--cmp-string-call-dupes']],
    ['notable_funcstr_matches','int',          ['--notable-funcstr-matches']],
    ['nf_min_lines',         'int',            ['--nf-min-lines']],
    ['nf_min_surprise',      'value',          ['--nf-min-surprise']],
    ['nf_sort',              'value',          ['--nf-sort']],
    ['nf_tight',             'flag',           ['--nf-tight']],
    ['funcstr_hashes',       'int',            ['--funcstr-hashes']],
    ['funcstr_corpus',       'value',          ['--funcstr-corpus']],
    ['exclude_corpus',       'value',          ['--exclude-corpus']],
    ['fc_common_df',         'int',            ['--fc-common-df']],
    ['fc_rare_df',           'int',            ['--fc-rare-df']],
    ['fh_tight',             'flag',           ['--fh-tight']],
    ['fingerprint_min_tokens','int',           ['--fingerprint-min-tokens']],
    ['fingerprint_work',     'value',          ['--fingerprint-work']],
    ['fingerprint_ref',      'value',          ['--fingerprint-ref']],
    ['show_tokens',          'flag',           ['--show-tokens']],
    ['build_fp_renames',     'optional_value', ['--build-fp-renames', '--build-fingerprint-renames']],
    ['dry_run',              'flag',           ['--dry-run']],
    ['fp_classes',           'flag',           ['--fp-classes']],
    ['save_fingerprints',    'value',          ['--save-fingerprints']],
    ['load_fingerprints',    'list',           ['--load-fingerprints']],
    ['clean_fp',             'flag',           ['--clean-fp']],

    // New: content analysis
    ['command_catalog',      'flag',           ['--command-catalog']],
    ['string_table',         'optional_value', ['--string-table', '--strings']],
    ['breadcrumbs',          'flag',           ['--breadcrumbs']],
    ['prompt_catalog',       'flag',           ['--prompt-catalog', '--prompts']],
    ['no_rename',            'flag',           ['--no-rename']],

    // Binary-bundled-JS extraction (#74)
    ['extract_js_from_binary','value',          ['--extract-js-from-binary']],
    ['output_dir',           'value',          ['--output-dir']],

    // Binary inspection (#77) — list type so shell-expanded globs work:
    //   --inspect-binary /usr/bin/*.exe   (bash expands, all values captured)
    //   --inspect-binary "/usr/bin/*.exe" (quoted; CE expands internally)
    //   --inspect-binary @list.txt        (filelist; processed per-item)
    ['inspect_binary',       'list',           ['--inspect-binary']],

    // Bundle-seam splitting at index time (#20)
    ['split_bundle',         'flag',           ['--split-bundle']],
  ];

  // Build alias lookup.
  //
  // Each def is [name, type, canonicalAliases, deprecatedAliases?].
  // Canonical aliases resolve silently; deprecated aliases also resolve but
  // emit a one-time stderr warning recommending the canonical form (first
  // entry of canonicalAliases). If a flag has no canonical aliases (an empty
  // canonicalAliases array), the deprecated form still resolves but the
  // warning message names the canonical command pattern that replaces it
  // (case-specific message dispatched below).
  const aliasMap = new Map(); // alias -> { name, type, deprecated, canonical }
  for (const [name, type, aliases, deprecatedAliases = []] of defs) {
    const canonical = aliases[0] || null;  // null when the only forms are deprecated (e.g. --follow-calls)
    for (const alias of aliases) {
      aliasMap.set(alias, { name, type, deprecated: false, canonical });
    }
    for (const alias of deprecatedAliases) {
      aliasMap.set(alias, { name, type, deprecated: true, canonical });
    }
  }

  // Per-process deduplication of deprecation warnings.
  const warnedDeprecated = new Set();
  const deprecationMessage = (token, canonical) => {
    // Special-cased migration hints for cases where the replacement is not a
    // single canonical alias (e.g. --follow-calls -> --deep 1).
    const special = {
      '--follow-calls':           '--deep 1',
      '--list-functions-alpha':   '--functions --sort alpha',
      '--list-functions-size':    '--functions --sort size',
      '--claim-model':            '--model',
      '--analyze-model':          '--model',
      '--term-extract-model':     '--model',
      '--use-claude':             '--llm claude',
    };
    const target = special[token] || canonical || '(no direct replacement; see docs/cli.md)';
    return `Warning: ${token} is deprecated; use ${target} instead.`;
  };

  let i = 0;
  while (i < argv.length) {
    let token = argv[i];

    // Handle --help (optional filter: --help cpu  or  --help=cpu)
    if (token === '--help' || token === '-h' || token === '--usage' ||
        token.startsWith('--help=') || token.startsWith('--usage=') || token.startsWith('-h=')) {
      let helpFilter = null;
      if (token.includes('=')) helpFilter = token.slice(token.indexOf('=') + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) helpFilter = argv[i + 1];
      printUsage(helpFilter);
      process.exit(0);
    }
    if (token === '--version') {
      console.log(`CodeExam ${VERSION}`);
      process.exit(0);
    }

    // Handle --arg=value
    let eqValue = null;
    const eqIdx = token.indexOf('=');
    if (eqIdx > 0 && token.startsWith('--')) {
      eqValue = token.slice(eqIdx + 1);
      token = token.slice(0, eqIdx);
    }

    let def = aliasMap.get(token);
    // #239: accept the underscore spelling of a hyphenated flag (the form used by
    // the MCP tools, internal arg keys, REPL, and docs) — e.g. `--command_catalog`
    // resolves to `--command-catalog`. Flag-shaped tokens only; genuine unknowns
    // still fall through to the error path below.
    if (!def && token.startsWith('-') && token.includes('_')) {
      def = aliasMap.get(token.replace(/_/g, '-'));
    }
    if (!def) {
      // Unknown token: a mistyped flag, or an unexpected positional. Collect it;
      // the dispatcher reports + exits (before the index load) so the error is
      // not masked by "No index found". #69.
      if (token.startsWith('-')) {
        const suggestion = suggestClosest(token, aliasMap);
        args._unknownFlags.push({ token, suggestion });
      } else {
        args._unknownPositionals.push(token);
      }
      i++;
      continue;
    }

    if (def.deprecated && !warnedDeprecated.has(token)) {
      console.error(deprecationMessage(token, def.canonical));
      warnedDeprecated.add(token);
    }

    args._explicit.add(def.name);

    switch (def.type) {
      case 'flag':
        args[def.name] = true;
        i++;
        break;

      case 'value':
        if (eqValue !== null) {
          args[def.name] = eqValue;
          i++;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          args[def.name] = argv[i + 1];
          i += 2;
        } else {
          console.error(`Error: ${token} requires a value`);
          process.exit(1);
        }
        break;

      case 'int': {
        let val;
        if (eqValue !== null) {
          val = eqValue;
          i++;
        } else if (i + 1 < argv.length) {
          val = argv[i + 1];
          i += 2;
        } else {
          console.error(`Error: ${token} requires a number`);
          process.exit(1);
        }
        const n = parseInt(val, 10);
        if (isNaN(n)) {
          console.error(`Error: ${token} requires a number, got '${val}'`);
          process.exit(1);
        }
        args[def.name] = n;
        break;
      }

      case 'float': {
        let val;
        if (eqValue !== null) {
          val = eqValue;
          i++;
        } else if (i + 1 < argv.length) {
          val = argv[i + 1];
          i += 2;
        } else {
          console.error(`Error: ${token} requires a number`);
          process.exit(1);
        }
        const f = parseFloat(val);
        if (isNaN(f)) {
          console.error(`Error: ${token} requires a number, got '${val}'`);
          process.exit(1);
        }
        args[def.name] = f;
        break;
      }

      case 'optional_value':
        if (eqValue !== null) {
          args[def.name] = eqValue;
          i++;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          // Guard on a single '-' (not '--'): the optional value is a name /
          // filter / pattern that never starts with a dash, so a following
          // flag like `-v` or `--filter` must NOT be swallowed as the value.
          // (`--class-tree -v` was reading "-v" as the class filter.) Required
          // 'value' args keep the looser '--' guard since a regex/search term
          // can legitimately begin with a single '-'.
          args[def.name] = argv[i + 1];
          i += 2;
        } else {
          // Flag-only, no value: use default marker
          args[def.name] = '.';
          i++;
        }
        break;

      case 'list':
        if (!args[def.name]) args[def.name] = [];
        if (eqValue !== null) {
          args[def.name].push(eqValue);
          i++;
        } else {
          i++;
          // Consume all following non-flag tokens. #252: stop on a single '-'
          // too, not just '--' — list values are paths/patterns that never
          // start with a dash (same reasoning as the optional_value guard
          // above), and `--inspect-binary app.exe -v` was eating the `-v`.
          while (i < argv.length && !argv[i].startsWith('-')) {
            args[def.name].push(argv[i]);
            i++;
          }
        }
        if (args[def.name].length === 0) args[def.name] = null;
        break;
    }
  }

  // Post-parse fan-out: keep canonical and legacy fields in sync in both
  // directions, so consumers reading either name see the same effective
  // value regardless of which CLI form the user typed.
  if (args.list_functions_alpha && !args.sort) args.sort = 'alpha';
  if (args.list_functions_size && !args.sort) args.sort = 'size';
  if (args.sort === 'alpha' && !args.list_functions_alpha) args.list_functions_alpha = true;
  if (args.sort === 'size' && !args.list_functions_size) args.list_functions_size = true;
  if (args.use_claude && !args.llm) args.llm = 'claude';
  // #246: normalize + validate --llm through the ONE provider registry
  // (src/core/providers.js), so the alias/rejection list can't drift from the
  // GUI server's copy. Unknown value → fail loud (never coerce to Claude, the
  // old else-branch behavior). --llm selects a CLOUD provider only; a local
  // GGUF is chosen with --model <gguf>, so --llm local / *.gguf are refused
  // with a local-specific hint.
  if (typeof args.llm === 'string' && args.llm) {
    const norm = args.llm.toLowerCase().trim();
    const { provider, error } = resolveProvider(norm, { allowDefault: false });
    if (provider) {
      args.llm = provider.id;   // canonical id: claude | openai | gemini
    } else {
      if (norm === 'local' || norm.endsWith('.gguf')) {
        const ex = norm.endsWith('.gguf') ? ` (e.g. --model ${args.llm})` : '';
        process.stderr.write(`ERROR: --llm selects a CLOUD provider, not a local model. For a local GGUF model, use --model <gguf>${ex} instead.\n`);
      } else {
        process.stderr.write(`ERROR: ${error}\n`);
      }
      process.exit(1);
    }
  }
  // Back-compat booleans for the paths not yet migrated to the resolver; the
  // canonical selector downstream is args.llm (the provider id). gemini has no
  // boolean — those sites read args.llm via resolveProvider.
  if (args.llm === 'claude') args.use_claude = true;
  if (args.llm === 'openai') args.use_openai = true;
  if (args.claim_model && !args.model) args.model = args.claim_model;
  if (args.analyze_model && !args.model) args.model = args.analyze_model;
  if (args.model && !args.claim_model) args.claim_model = args.model;
  if (args.model && !args.analyze_model) args.analyze_model = args.model;
  if (args.follow_calls && args.deep === null) args.deep = '1';

  // --granularity is an enumeration, and a typo must not silently become the
  // default: a chart's row structure is the one thing two charts are compared on.
  if (args.granularity !== 'fine' && args.granularity !== 'coarse') {
    console.error(`--granularity must be "fine" or "coarse", got "${args.granularity}".`);
    process.exit(2);
  }
  if (args.claim_number != null && !/^[1-9][0-9]*$/.test(String(args.claim_number).trim())) {
    console.error(`--claim-number must be a positive claim number, got "${args.claim_number}".`);
    process.exit(2);
  }
  // --shape-profile is an enumeration; a typo must not silently become the default population.
  if (!['litigated', 'ai-ml', 'randpat'].includes(String(args.shape_profile))) {
    console.error(`--shape-profile must be "litigated", "ai-ml" or "randpat", got "${args.shape_profile}".`);
    process.exit(2);
  }
  return args;
}


/**
 * Filter the usage text to the option entries (and their parent section header)
 * matching `filter` (case-insensitive). An entry is a 2-space-indented line plus
 * its more-indented continuation lines; section headers are column-0 lines ending
 * in ':'. Backs `--help <filter>` (e.g. `--help cpu`).
 */
export function filterHelp(text, filter) {
  const f = String(filter).toLowerCase();
  const lines = String(text).split('\n');
  const isHeader = (l) => /^\S.*:\s*$/.test(l);
  const isEntry = (l) => /^ {2}\S/.test(l);
  const out = [];
  let section = null, sectionEmitted = false, block = null;
  const flush = () => {
    if (block && block.join('\n').toLowerCase().includes(f)) {
      if (section && !sectionEmitted) { out.push('', section); sectionEmitted = true; }
      out.push(...block);
    }
    block = null;
  };
  for (const line of lines) {
    if (isHeader(line)) { flush(); section = line; sectionEmitted = false; }
    else if (isEntry(line)) { flush(); block = [line]; }
    else if (block && /^\s+\S/.test(line)) { block.push(line); }
    else { flush(); }
  }
  flush();
  const body = out.join('\n').replace(/^\n+/, '');
  return body
    ? `code-exam — help entries matching "${filter}":\n\n${body}`
    : `No help entries match "${filter}". Run --help with no filter for the full list.`;
}

function printUsage(filter) {
  const usage = `
${BANNER}

USAGE:
  node src/index.js [options]
  --help [filter]            Show this help; with a filter, show only matching
                             option entries (e.g. --help cpu)

INDEX MANAGEMENT:
  --build-index <path>       Build index from directory, file, glob, @filelist,
                             archive (.zip/.tar/.gz), or .har network capture
                             (DevTools "Save all as HAR" — indexes the JS/CSS/
                             HTML the page actually loaded; no network access)
  --split-bundle             With --build-index: detect esbuild-style bundle
                             seams in large JS files (>=10K lines) and split
                             each detected bundled file into N virtual files
                             named <orig>::<wrapper-name>.js. Each module
                             becomes its own searchable / cross-referenceable
                             unit. Restores meaningful multi-document
                             vocabulary / TF-IDF / file-map on bundled apps
                             (claude.exe's extracted cli.js, mermaid.min.js,
                             etc.). Opt-in: when not set, bundled files are
                             indexed as today (single entry per file).
  --rebuild-functions        Rebuild function index from loaded file contents
  --build-rename-map         (Re)infer descriptive names for an existing index;
                             writes rename_map.json + import_map.json without
                             rebuilding the index itself
  --rename-min-lines <n>     When (re)building rename map, skip functions with
                             lineCount <= n. 0 = no threshold (default), useful
                             for tuning rename coverage vs noise on short
                             functions. Pair with --build-rename-map.
  --no-rename                Disable display-time renames for this run
                             (output uses raw obfuscated names)
  --index-path <path>        Load an existing index (alias: --load-index).
                             Default .code_search_index. Also accepts a .zip of
                             an index (e.g. a shipped sample) — extracted to a
                             temp cache on first load.
  --multi-index @filelist    Alternative to --index-path: fan the rest of the
                             command across many indexes. @filelist holds one
                             index directory path per line; CodeExam runs the
                             command against each and concatenates the output
                             (per-index header, no aggregation). A run uses
                             either --index-path or --multi-index, not both.
  --skip-semantic            Skip semantic/embedding indexing (default)
  --use-tree-sitter          Use tree-sitter for function parsing
  --extensions <exts>        Comma-separated file extensions to index
                             (replaces the default set)
  --add-extensions <exts>    Comma-separated extensions to ADD to the default
                             set (e.g. --add-extensions .xmlui,.xs,.md). Quote the
                             list if your shell treats a character specially:
                             --add-extensions ".jinja2,.tmpl"
  --exclude-extensions <exts> Comma-separated extensions to exclude from index
  --demangler <path>         Path to C++ name demangler (e.g., vc++filt.exe, c++filt)

SEARCH:
  --search <query>           Hybrid search (literal + semantic)
  --literal <query>          Literal/exact text search
  --fast <query>             Fast inverted-index search
  --regex <pattern>          Regex pattern search
  --files-search <query>     Show files containing a term, sorted by hit count
  --folders-search <query>   Show folders containing a term, sorted by hit count
  --multisect-search <terms> Multi-term intersection search (semicolon-separated terms)
                             Finds smallest scope (function/class/file/folder) containing
                             "substantially all" terms. Default requires ALL positive terms;
                             use --min-terms N to require only N of them (partial matching).
                             Terms in /.../ are regex. Prefix with NOT or ! to negate.
  --in <pattern>             Universal path filter — restrict search, multisect &
                             vocabulary output to files whose path contains <pattern>
  --show-dupes               Show file duplicate paths in output

BROWSE:
  --stats                    Show index statistics
  --files [pattern]          List indexed files (optional filter)
                             (deprecated alias: --list-files)
  --show-file <pattern>      Display entire file contents
  --functions [pattern]      List functions (optional filter). Use --sort
                             alpha|size to change ordering.
                             (deprecated alias: --list-functions)
  --sort <mode>              Sort mode for --functions / --files (alpha|size)
                             Replaces --list-functions-alpha / -size.
  --extract <spec>           Extract function source: FUNCTION or FILE@FUNCTION
  --deep [N]                 With --extract: also dump callees, N levels deep
                             (default: 1). Replaces --follow-calls.
  --comments-only [target]   Standalone: print just the comments inside the
                             named target (function / class / file), organized
                             as a map. Without a target, acts as a legacy
                             modifier flag for --extract (shows only comments
                             in the extracted function's body).
  --scan-extensions <path>   Count file extensions in a directory
  --index-extensions         Count file extensions in current index
  --overview                 One-shot orientation: size, languages, structure,
                             top vocabulary, key files, entry points (run first)
  --overview-by-ai           Prose 1-2 page orientation written by running an
                             LLM AGENTICALLY over CE's own MCP tools against this
                             index (overview -> shape-appropriate tools ->
                             synthesis); prints prose to stdout. Two engines:
                             by default calls the Anthropic API (NON-AIR-GAPPED;
                             needs ANTHROPIC_API_KEY) — --claude-model <id> picks
                             the API model. Pass --model <model.gguf> to run a
                             LOCAL model in-process via node-llama-cpp instead
                             (AIR-GAPPED; no network). Pairs with --multi-index
                             @list for overnight batch.
                             --timeout <minutes> caps the run (default 20); reads
                             CE_AI_OVERVIEW_MODEL / CE_AI_OVERVIEW_TIMEOUT_MS as
                             fallbacks.
  --cpu                      With --overview-by-ai --model: force the local GGUF
                             onto the CPU (full system RAM) instead of the GPU.
                             Prefer this on an integrated/small GPU: the default
                             only recovers from GPU out-of-memory, NOT from other
                             GPU failures (e.g. backend crashes).
  --grounding <mode>         With --overview-by-ai: how freely the model may use
                             knowledge beyond the codebase. grounded (default) =
                             code only, says "not determinable" instead of
                             guessing; augmented = + general knowledge; attributed
                             = + general knowledge with provenance flagged. Same
                             modes as the GUI chat's Grounding selector.
  --cost / --no-cost         With --overview-by-ai: show (default) or suppress the
                             cost/usage line on stderr after the run. For the
                             cloud engine: estimated $ + token counts; for a local
                             --model GGUF: output token count only (air-gapped, no
                             API cost). stderr-only, so --multi-index stdout
                             capture stays pure prose.
  --max-budget-usd <amount>  With --overview-by-ai (cloud engine): hard spend cap;
                             the agentic run aborts once the summed per-turn cost
                             would exceed <amount>. Default $5; also settable via
                             the CE_OVERVIEW_MAX_BUDGET env var (this flag wins).
                             Local --model GGUF is air-gapped — no cap.
  --air-gapped               Block ALL cloud AI calls this run (claim/analyze
                             LLM, chat, AI Overview); ANTHROPIC_API_KEY is
                             ignored. Use a local --model GGUF (or a localhost
                             LLM endpoint) to still get AI. Refuses to start if
                             the internet is reachable — pass --allow-connected
                             to override. Does NOT isolate your environment (see
                             AIR_GAPPED.md). For litigation / protective-order use.
  --allow-connected          With --air-gapped: proceed even if the internet is
                             reachable (the block stays active). For deliberately
                             running air-gapped CE on a connected machine.
  --indexes [path]           List available index directories
                             (deprecated alias: --list-indexes)

DISPLAY / FILTERING (query-time, does not affect index build):
  --max-results <n>          Maximum results to display (alias: --max) (default: 20)
  --context <n>              Context lines around matches (default: 3)
  -v, --verbose              Show extra detail
  --full-path                Show full file paths in output
  --provenance               Print a provenance header at the top of stdout:
                             CE version + generation time, tool source URL,
                             index, and the invoking command (secrets masked).
                             For output you redirect to a file and share —
                             default OFF so piped output stays clean. AI
                             engine/model flags are echoed when given.
  --filter <text>            Substring filter for most listings — functions, files,
                             classes, the AI/ML detector cells, and --prompt-catalog.
                             --prompt-catalog also accepts a /regex/ form, e.g.
                             --filter "/step.?by.?step|chain.of.thought/"
  --include-path <patterns>  Only include paths containing pattern(s)
  --exclude-path <patterns>  Exclude paths containing pattern(s)
  --exclude-tests            Exclude test files from callers/metrics results
  --no-tests                 AI/ML cells: drop records tagged test/example code
                             (tests, examples, benchmarks, demos dirs; test_* etc.)
  --emit-harness <Class>     Emit a runnable PyTorch forward-hook activation
                             harness .py for a detected model class (file@Class
                             to disambiguate). CE never runs it — you do.
                             Never overwrites: an existing file gets _2/_3.
                             --harness-template NAME — only activation-hook
                             exists today (SHAP/LIME/UMAP lanes are #95
                             follow-ups); --out PATH (default
                             <Class>_harness.py). "Seam" here = a model
                             instrumentation point — unrelated to
                             --bundle-seams (JS bundle boundaries).
  --synthetic-loader         With --emit-harness: opt-in, mechanically fill
                             load_model() with a shrunk-config + random-weight
                             loader (STRUCTURE-validation only; activation
                             values are noise). Best-effort — leaves # FIXME at
                             shapes it can't resolve; falls back to the stub
                             when it can't instantiate.
  --list-harnessable         Sweep the index's PyTorch models and report which
                             --emit-harness --synthetic-loader can auto-fill
                             (vs need a hand-written loader). Honors --filter.
  --census-imports           Ranked import census: what the code actually
                             imports (Python today; JS/TS is #154). With
                             --multi-index <list> it reduces ACROSS indexes —
                             ranked by how many indexes import each target —
                             the corpus's de facto API map. Honors --filter;
                             -v drills per-index counts / example sites.
  --exports [pkg]            Declared-exports catalog (Python today): what
                             each package SAYS its public API is, tier-marked
                             (A __all__/@*_export, B __init__ re-exports,
                             C heuristic floor) and resolved to definition
                             sites. Bare --exports = per-package summary;
                             --exports <pkg> lists that package's names
                             (segment-matched: 'decomposition' does not pull
                             in 'cross_decomposition'). Honors --filter; -v
                             adds idiom + declaration sites.
  --emit-catalog <file>      With --exports (esp. --multi-index): write the
                             export catalog to a reusable JSON file instead of
                             the console — library-keyed and de-duped (one
                             entry per importable library; overlapping indexes
                             keep the richest copy, others noted in
                             alsoProvidedBy). Appendable: merges into an
                             existing file by index identity (--catalog-replace
                             overwrites). Consumed by --imports (#162). A
                             --multi-index emit also records who-uses
                             provenance (#162b).
  --used-by <catalog>        With --exports: annotate each export with the
                             corpus codebases that import it (the de facto
                             API), read from a who-uses catalog (--multi-index
                             --emit-catalog). Surfaces declared-but-unused
                             exports (public surface nobody imports). Needs a
                             v2 catalog.
  --imports-from <index>     Cross-index join (#154): resolve THIS index's
                             imports of a library against that library
                             index's export catalog. Verdicts: resolved
                             (tier + def site), private-or-internal (exists
                             in B but not publicly exported — fragile
                             coupling), not-found-in-B (version skew).
                             Honors --filter; -v adds use sites + the
                             unused-exports reverse view.
  --imports <catalog.json>   Discovery join (#162): resolve THIS index's
                             imports against a pre-built multi-library catalog
                             (--exports --emit-catalog). Each import is
                             attributed to whichever catalogued library
                             provides it — no need to name the library. Same
                             verdicts as --imports-from, plus the providing
                             library. Resolves named imports AND qualified
                             attribute access (import shap; shap.Explainer()).
                             Honors --filter; -v adds use sites.
  --infrastructure, --infra  Non-AI/ML operational stack (#168): Containers,
                             Kubernetes, IaC (Terraform/CloudFormation/Pulumi/
                             Ansible), and CI/CD (GitHub Actions/GitLab/CircleCI)
                             by file shape. Mechanical findings unmarked,
                             heuristic (content-sniffed) marked ~. Honors
                             --filter; -v lists all rows per cell.
  --dedup <mode>             Dedup mode: none, exact, structural

MODE:
  -i, --interactive          Start interactive REPL mode (needs a loaded index —
                             pass --index-path / --load-index)
  --gui                      Launch the browser GUI (starts a local server and
                             opens your browser). Also accepts --index-path /
                             --port and the --model / --api-key flags.
  --port <n>                 GUI server port (default 8080)
  --context-size <n>         GUI server: preferred local-model context size
                             (first rung of the 8192/4096/2048 ladder; falls
                             back on OOM, so safe to over-ask). Agentic chat
                             wants 16384+ when VRAM allows.
  --flash-attention          Local GGUF only: enable flash attention on the
                             model context. Frees VRAM for the KV cache —
                             measured 0.5 GB (Gemma-3-12B) to 2.3 GB
                             (gpt-oss-20b) at ctx 16384, which is the
                             difference between a 20B model fitting on a 16 GB
                             card and not fitting at all. OFF by default:
                             node-llama-cpp 3.18.1 flags it experimental and it
                             may change numerics, so it is opt-in and belongs
                             in any run you intend to compare.
  --live-today-date          Local GGUF only: let node-llama-cpp inject the live
                             date into the system prompt. OFF by default, which
                             pins it. node-llama-cpp's Llama 3.1/3.2 wrappers
                             default that field to a clock, so the same command
                             on the same index produced different output on
                             different days. A code index has no "today", and
                             --reproducible does NOT cover this — that pins
                             sampling, this is prompt text. Other families
                             (Gemma, Mistral, Qwen) inject nothing and are
                             unaffected either way.
  --reproducible             GUI server: pin local-model sampling (temperature
                             0, fixed seed) so the same question over the same
                             index/model/config repeats the same answer on this
                             machine. Default: sampling on (answers vary).
  --openai-key <key>         GUI server: OpenAI API key for the ChatGPT engine
                             (or set OPENAI_API_KEY / create openai.txt).
  --openai-model <id>        GUI server: OpenAI / ChatGPT model id (default
                             gpt-5.1; or set CE_OPENAI_MODEL). Used by the
                             ChatGPT engine in Chat, Analyze, and Overview
                             by AI.
  --gemini-key <key>         Gemini API key for --llm gemini (or set
                             GEMINI_API_KEY / create gemini.txt). #246
  --gemini-model <id>        Gemini model id (default gemini-2.5-flash).

CALLERS / CALLEES:
  --callers <spec>           Find callers of a function (FUNC or FILE@FUNC)
  --callees <spec>           Find functions called by a function
  --call-inventory [spec]    Show call targets partitioned into in-index vs external
                             No argument: scan entire codebase (bill of materials)
                             With function name: single function inventory
                             Use --filter to search externals, --verbose for in-index list
  --most-called <n>          Show top N most frequently called functions
  --depth <n>                Depth for transitive callers (default when used
                             with --callers: 1) or for tree views (default
                             when used with --call-tree / --file-tree: 3).
                             The default is consumer-specific; check the
                             help text of the command you are pairing with.
  --min-name-length <n>      Filter out short names in --most-called (default: 1)
  --include-macros           Include ALL_CAPS names in --most-called
  --defined-only             Only show functions defined in the index

GRAPH:
  --call-tree <spec>         Show call tree (callers up + callees down)
  --class-tree [filter]      Show class inheritance hierarchy
  --file-map [filter]        Show file-level dependency map
  --file-tree <file>         Show file dependency tree
  --mermaid                  Output Mermaid diagram instead of text

METRICS / DISCOVERY:
  --classes                  List all classes with method counts/sizes
                             (deprecated alias: --list-classes)
  --data-structs             List data structures (struct/enum/union/typedef/
                             trait/interface/record) ranked by reference count
                             (alias: --structs)
  --client-server            Map the HTTP surface: server routes declared,
                             client calls made, and client calls with no
                             matching server route (alias: --routes)
  --referenced-resources [subsections]
                             Map the codebase's EXTERNAL surface — the things it
                             points to but doesn't contain: URLs/hosts,
                             environment variables, filesystem paths, embedded
                             SQL, external commands (spawn/exec/subprocess),
                             cloud/infra config, and model IDs — each ranked by
                             reference count with file:line sites.
                             (alias: --resources). Honors --filter, --max-results.
                             Optional comma-separated subsections to show only
                             those — QUOTE them: --referenced-resources "sql,env"
                             (unquoted, some shells e.g. PowerShell split on the
                             comma and only the first is read). Names:
                               network  (URLs/hosts; aliases: urls)
                               env      (environment variables; aliases: envvars)
                               files    (filesystem files with extensions)
                               paths    (filesystem dirs/route paths; alias: routes)
                               sql      (embedded SQL; alias: embed-sql)
                               commands (external commands; aliases: cmds, exec)
                               cloud    (cloud/infra config; alias: infra)
                               models   (model IDs)
  --vocabulary <n>           Top N domain-specific tokens by TF-IDF score
                             (short alias: --vocab; deprecated alias:
                             --discover-vocabulary)
  --hotspots <n>             Top N structurally important functions (calls x log2(lines))
  --hot-folders <n>          Top N directories by aggregated hotspot score
  --class-hotspots <n>       Top N classes by aggregated method hotspot score
  --entry-points <n>         Top N uncalled functions (sorted by size)
  --max-calls <n>            Max call count for entry-points (default: 0 = never called)
  --gaps [n]                 Find suspicious dead code (defined, no callers, not entry-point)
  --domain-fns <n>           Top N domain-specific functions (score / sqrt(name defs))

AI/ML DETECTORS (list AI/ML constructs; each has a --list-<name> alias):
  --pipelines                Connected AI/ML pipelines (RAG/training/inference/agent/LLM-app) by cell co-occurrence
  --explainability           Analysis/interpretability/dim-reduction usage (SHAP/LIME/Captum attribution;
                             PCA/t-SNE/UMAP) — import-gated: a Tier-A library import in the file anchors its
                             Tier-B calls, so prose/tokenizer-JSON don't false-positive (alias --analysis)
  --prompt-catalog           Detect and display LLM prompts in the codebase:
                             system prompts ("You are..."), getSystemPrompt methods,
                             systemPrompt: properties, role:"system" messages, and
                             build*Prompt functions. Full text, no truncation — pipe
                             to a file and grep for keywords. (alias: --prompts)
  --llm-calls                LLM API calls (messages.create, ChatOpenAI, LlamaChatSession)
  --reasoning                Reasoning-prompt language (CoT "think step by step", reflection/reflexion,
                             scratchpad) — HEURISTIC (prompt prose, not constructs); misses Tree-of-Thoughts
  --tools                    Tool defs / function-calling (@tool, input_schema, MCP, tool_use)
  --chains                   Chains/agents (LangChain/LangGraph/DSPy/CrewAI; framework-based only)
  --embeddings               Embeddings & vector search (FAISS/Chroma, similarity_search, distance)
  --structured-output        Structured output / schemas (with_structured_output, response_format, parsers)
  --inference                Local inference/generation (generate, no_grad, .predict)
  --training                 Training sites (PyTorch loop, Trainer, .fit)
  --post-training            Post-training/fine-tuning (LoRA/PEFT, SFT/DPO/PPO/GRPO, distillation) [alias: --finetuning]
  --datasets                 Datasets (Dataset/IterableDataset, tf.data, ML loaders)
  --artifacts                Model load/save sites (from_pretrained, GGUF, safetensors)
  --models                   ML model classes (nn.Module / keras / sklearn subclasses)
  --models-used              Models USED — named models loaded/called across the cells, deduped (api/local)
  --kernels                  GPU kernels (CUDA __global__, Triton @triton.jit, numba)
  --multimodal               Multimodal/vision (CLIP/ViT/ResNet/YOLO/diffusion/VLM) [alias: --vision]

CLAIM SEARCH (LLM-based patent claim analysis):
  --claim-search <text>      Extract search terms from patent claim text
                             (use @file.txt to read from file).
  --claim-file <path>        Read patent claim text from file (alternative
                             to --claim-search @file.txt; specific to the
                             claim-search code path).
  --claim-number <n>         --claim-search / --claim-analyze: which claim of
                             a multi-claim input to use (default: the first).
                             A dependent claim is used with every limitation
                             it inherits up its chain, and the output names
                             the claims it inherited from; the other claims
                             are not used, and the note counts how many were
                             dependent and how many independent.
  --llm <provider>           Select cloud LLM provider: 'claude', 'openai'
                             (alias 'chatgpt'/'gpt'), or 'gemini' (alias
                             'google'). Requires that provider's API key. An
                             unrecognized value is rejected — never silently
                             routed to Claude (#246). A local GGUF is --model
                             <gguf>, not --llm.
                             (deprecated alias: --use-claude → --llm claude)
  --api-key <key>            API key for the selected provider (overrides env var)
  --model <path.gguf>        Local GGUF model path for term extraction and
                             analysis. Replaces both --claim-model and
                             --analyze-model. If you genuinely need different
                             models for term-extraction vs. analysis, the
                             two old flags are still accepted.
  --claude-model <id>        Claude API model id for term extraction / analysis
                             (e.g. claude-sonnet-4-6). Distinct from --model
                             (which is a local GGUF path). Overrides the
                             CLAIM_SEARCH_MODEL env var; default claude-sonnet-4-6.
  --temperature <float>      LLM temperature (default: 0.0)
  --show-prompt              Display the LLM prompt and exit (no API call)
  --vocab-tight              Also use codebase vocabulary for TIGHT term generation
                              (default: vocabulary only influences BROAD terms)
  --no-vocabulary            Disable codebase vocabulary in term extraction prompts
                              (alias: --no-vocab) For A/B testing vocabulary guidance.

PSEUDO-CLAIMS (illustrative patent-style claim drafting — NOT legal analysis):
  --pseudo-claims <anchors>  Draft illustrative "pseudo patent claims" from
                             evidence packs of explicit anchor functions. One
                             anchor GROUP = one pseudo-claim. Anchors are
                             "file@func;file@func" (a single claim) or
                             @anchors.lst (one file@func per line; a "# Label"
                             line starts a new claim, so one file yields many
                             claims). Each anchor must resolve to a real function
                             in the index; unresolved/ambiguous anchors are
                             dropped with a message. Anchors may be supplied
                             explicitly OR auto-discovered with --candidates
                             (below); worthiness ranking (--auto) is still
                             deferred. Output carries a non-removable PSEUDO /
                             non-admission caveat: it is NOT legal advice and NOT
                             an admission that any code practices any claim.
                             Drafts one claim per group via --llm
                             claude|openai|gemini (keys from ANTHROPIC_API_KEY /
                             OPENAI_API_KEY / GEMINI_API_KEY, same as the analyze
                             commands) or a local GGUF (--model <gguf>, --cpu
                             forces CPU); air-gap honored. Each cited anchor is
                             grounded (must resolve to a real function) or
                             dropped. With no model (or --dry-run) it stops after
                             the evidence pack. (CE_OPENAI_API_URL still points
                             the openai-compat wire at a localhost gateway.)
  --pseudo-out <file>        Write the pseudo-claims artifact to <file> (UTF-8)
                             instead of stdout.
  --dry-run                  With --pseudo-claims: emit the caveat + evidence
                             packs only, skipping the model draft even when one
                             is configured.
  --candidates <file>        With --pseudo-claims: AUTO-DISCOVER unranked candidate
                             mechanism groups (deterministic, no LLM) → <file>;
                             hand-prune, then --pseudo-claims @<file> --dry-run.
  --group-by <mode>          With --candidates: 'multi' (default: name-token +
                             class seeds) | 'concept' (token-only baseline).
  --include-vendored         With --candidates: KEEP third-party subtrees that
                             would otherwise be excluded from candidate
                             discovery. A subtree is called third-party when it
                             is a NESTED package root (setup.py / pyproject.toml
                             / package.json / Cargo.toml / go.mod) AND its files
                             carry a dominant copyright holder. Every exclusion
                             is named in the candidates file header. Vendored
                             code is the client's LEAST claim-worthy material —
                             not their invention, most likely to be prior art —
                             so it is out by default. The index is untouched;
                             search/digest still see it.
  --group-max <n>            With --candidates: split any group larger than <n>
                             functions by re-grouping over its own members
                             (default 15; 0 disables). MEASURED: a group over 15
                             functions gets only ~34% of its functions cited by
                             the claim drafted from it, against ~85% for smaller
                             groups. A group that will not divide is emitted
                             intact and named in the file header. This is a
                             COVERAGE control, not a claim-length control.
  --file-seed                With --candidates: per-file groups for EVERY file
                             under the size cap (noisy on large C/C++ trees).
                             Default without it: a file seeds a group only when
                             it opens with a doc comment that says what the
                             module is for (any size; license-only headers do
                             not count) -- on CE and sr_gh that is the seed
                             that found the mechanisms the name-token seeds
                             missed (air-gapping, GGUF, binstrings; one script
                             per experiment). The candidates header counts what
                             it seeded and what it skipped.
  --no-file-seed             With --candidates: no per-file groups at all.
  --use-docs                 With --candidates: EXPERIMENTAL — include doc files
                             (.md/.txt/...) in the gather vocabulary so doc-borne
                             feature terms can seed groups (opt-in; code-only
                             stays default; measured to dilute as well as promote).
  --no-catalog-seed          With --candidates: opt OUT of the command-catalog
                             seed, which is ON by default. That seed groups by
                             COMMAND (option → handler + its callees), which is
                             how a CLI codebase is actually organized — MEASURED
                             on CE: files represented 43% → 60%, and the top
                             file's share of grouped functions falls 28% → 20%.
                             It is an exact no-op on a codebase with no command
                             surface. Use this flag to reproduce pre-default
                             candidate files.
  --catalog-max <n>          With --candidates: cap how many [cmd] groups the
                             command-catalog seed may form (default 24; 0 =
                             uncapped). Commands are tried biggest-mechanism-
                             first; when the cap is reached the candidates file
                             header says how many further commands were NOT
                             EVALUATED. A number you can see but not change is
                             barely better than one you cannot see.
  --catalog-seed             Accepted and inert — the seed it used to enable is
                             now the default. Kept so existing scripts run.
  --literal-seed             With --candidates: seed groups from rare SHARED
                             string literals (cross-file features joined by
                             their error strings/banners; language-agnostic;
                             opt-in).
  --body-match-seed          With --candidates: rescue concept tokens whose
                             name-match failed by matching function BODIES
                             (identifiers, call sites, strings; opt-in).
  --min-rank <0-3|P0-P3>     With --pseudo-claims @ranked.lst: draft only groups
                             at or above this floor. Default P2 when the list
                             carries [P..] tags; unranked lists draft all
                             groups, and untagged groups always draft. 0 =
                             draft everything.
  --shape-profile <name>     --pseudo-claims: which claim population the draft
                             should resemble -- litigated (default: 385
                             litigated software claim 1s), ai-ml (841 AI/ML
                             claim 1s, 2013-2017) or randpat (5,395 all-art
                             independents). Renders the prompt's numeric bands
                             and scores every draft's shape against the
                             profile (words, rows, mechanism elements,
                             dependents and their kind) in the artifact and
                             the sidecar. Length is a report, not a goal.
  --doc-anchors              With --candidates: attach each group's best-
                             matching documentation sections as path@L<a>-<b>
                             anchors (docs cited as evidence in packs and
                             charts; opt-in).
  --rank                     With --candidates: score each candidate's exploration
                             PRIORITY via --llm/--model, emit sorted + tagged
                             (observe-only; a surface heuristic to order where to
                             look first, NOT a novelty/worth judgment).
  --ground-truth <file>      With --candidates: score candidate recall/precision
                             vs a hand-authored anchors.lst (dev/eval) instead of
                             writing candidates.
  --include-evidence-pack    With --pseudo-claims: append each claim's evidence
                             pack to the drafted output (absent by default;
                             --dry-run always shows it). The model receives the
                             pack as input regardless.
  --pseudo-claims-chart      With --pseudo-claims: render each claim as a CLAIM
                             CHART — one row per claim element/step, with the
                             grounded cite(s) for that element — instead of a
                             flat anchor list.
  --triage <sidecar>         Deterministic FIRST CUT over a pseudo-claims run: reads
                             the .anchors.json sidecar --claims-only wrote, ranks
                             its claims KEEP / REVIEW / DROP with named reasons
                             (near-duplicate of a sibling, echo of a bigger group
                             over the same file, split residue, shape without
                             mechanism, no grounded anchor, vocabulary generic
                             within the run, weak dependents), and writes
                             <base>_triage.md (the ranked table) plus
                             <base>_keep.txt + .anchors.json (the KEEP tier, in
                             the one-claim-per-line form --synonymize and
                             --claim-chart read). Needs no index and no model.
                             Thresholds are pinned from the drafted-claim
                             population, never from anyone's picks. NOT a
                             judgment of novelty or worth: DROP means "look at
                             the others first". --shape-profile applies.
  --claims-only <file>       With --pseudo-claims: ALSO write a machine-readable
                             claims file — one claim per line, no caveat text,
                             no anchor tables — plus '<file>.anchors.json'
                             carrying each claim's GROUNDED anchors. The claims
                             file feeds straight into --synonymize; the sidecar
                             is the answer key a later recall comparison scores
                             against. Not available with --dry-run (no claims
                             have been drafted yet).

LLM ANALYSIS:
  --analyze <function>       Analyze a function with LLM ("what does this do?")
  --with <text>              Context text for --analyze (patent claim,
                             description, etc.) Analyze will explain the
                             code in relation to this text. Supports
                             @file.txt syntax to read from file.
  --claim-text <text>        Patent claim text for --claim-analyze (or
                             @file.txt). Distinct code path from --with;
                             --claim-text feeds the claim-analyze pipeline,
                             --with feeds the general analyze pipeline.
  --claim-chart <claim>      Build ONE claim chart: a row per claim element,
                              merged across --targets, with the best finding and
                              its citation per element. CE owns the table, the
                              caveats and the coverage summary, so charts from
                              different engines are directly comparable. Depth-1
                              callee BODIES are included by default so the crux
                              element is not judged on an inference. Takes
                              @file.txt or inline text.
  --claim-family             --claim-chart: chart claim 1 AND every dependent
                             claim beneath it (a claims file with numbered
                             claims). Claim 1 is charted as always; each
                             dependent's rows are its parent's rows plus what it
                             contributes: an ADDITION adds a row, a MODIFICATION
                             re-evaluates the one inherited row it narrows
                             (against the dependent's language, on the code the
                             parent row cited), inherited rows carry the
                             parent's verdict. Costs claim 1 plus the deltas.
                             Without it, a numbered claims file charts its
                             FIRST claim only (--claim-number <n> picks
                             another; a dependent charts its chain).
  --targets <list>           --claim-chart: "file@fn;file@fn" or @targets.txt.
                             Omit it to let CE retrieve evidence PER ELEMENT
                             instead (see --elements); supplying it keeps the
                             chart's behaviour exactly as before.
  --elements @file.txt       --claim-chart: take the claim's element list from a
                             file, one limitation per line ('#' lines are
                             comments carried into the provenance header),
                             instead of splitting the claim heuristically. No
                             regex reaches a practitioner's construction of a
                             claim, and letting a MODEL choose rows would make
                             two engines' charts undiffable — a file gives
                             practitioner granularity AND a skeleton identical
                             across every engine.
  --granularity <tier>       How --claim-chart / --claim-analyze / --claim-locate /
                             --synonymize split a claim into rows when no
                             --elements file is supplied. fine (default): the
                             litigator's rows -- every embedded "wherein", ", and"
                             and "which is" clause is its own separately-arguable
                             row. coarse: the drafter's rows -- sub-element
                             markers, lines, preamble-colon and semicolons only;
                             agrees with the drafting attorney's own element
                             count on 72% of 380 litigated claims. Recorded in
                             the chart header so two charts of one claim at
                             different tiers are never confused.
  --concentration-targets <n> --claim-chart, per-element retrieval only: when two
                             or more elements' top candidates share a file that
                             contributed no target, add that file's best hit ON
                             TOP of the budget (default 3, attributed as
                             "concentration"). The signal the per-element
                             round-robin cannot see: each element's slice of the
                             file can sit below its own depth cut while the file
                             is the strongest cross-element candidate. 0 disables.
  --verdicts-out <file>      --claim-chart: write the raw per-target verdicts
                             (analysis order, nominations, drops; the merge's
                             INPUT, no derived winners) as JSON. With
                             --claim-family, a "family" block is appended. This
                             is what merge-rule replays and the loop scorer
                             consume.
  --no-dep-synonyms          --claim-chart: do NOT let MODIFICATION dependents
                             donate species vocabulary to the parent rows they
                             narrow (claim differentiation; on by default when
                             the input carries such dependents)
  --whole-claim-targets <n>  --claim-chart, per-element retrieval only: ALSO add
                             up to <n> targets found by the CLAIM'S OWN words over
                             the whole symbol table (default 5), on top of the
                             per-element budget. The per-element words are what a
                             model predicts per element; this arm is the claim's
                             literal vocabulary, rarity-ranked, and finds code the
                             per-element words miss. Attributed on the chart as
                             "whole claim" / "(whole-claim arm)". 0 disables it.
  --targets-per-element <n>  --claim-chart, per-element retrieval only: how many
                             ranked candidates to analyse per claim element
                             (default 3). Charting is where cost trades against
                             depth, so both halves of that trade are flags.
  --max-retrieved-targets <n>
                             --claim-chart: COST ceiling on the total target
                             count (default 30). The total is normally derived
                             as --targets-per-element x elements; this caps it,
                             because every target is a model call — on a 24B
                             local model ~27 targets is roughly half an hour.
                             Lower it for casual use. When the ceiling binds,
                             the chart's provenance says BUDGET-LIMITED and
                             names the depth it could not reach.
  --include-op               --claim-chart / --claim-locate / --claim-analyze:
                             admit CE's own .op pseudo-source (binstrings
                             string-dumps of binaries) as retrieval
                             candidates. Held back by default: a dump is one
                             bin_<name> pseudo-function holding every string
                             in the binary, and it ranks like a function that
                             mentions everything. The chart's retrieval
                             section counts what was held back; an explicit
                             --targets list is always honoured as given.
  --no-callees               --claim-chart: omit depth-1 callee bodies (smaller
                              prompt; the analysis may then infer what a callee
                              does rather than read it).
  --scope-note <text>        --claim-chart: a structural fact stated ONCE above
                              the chart (e.g. that the index is one component of
                              a larger claimed system) instead of the model
                              re-deriving it on every element. Does not change
                              any verdict.
  --claim-locate <claim>     Locate the code implementing a claim by asking the
                              model to NAME the classes/methods it expects, then
                              VERIFYING each name against the index and
                              NAVIGATING one hop of callers/callees. Every
                              proposal is reported verified (with file@symbol and
                              line range) or NOT FOUND. Symbol names come from the
                              model's domain knowledge; existence and location
                              come from the index. Takes @file.txt or inline text.
  --no-refine                --claim-locate: skip the one refine round that feeds
                              real nearby symbol names back for NOT FOUND guesses.
  --blind                    --claim-locate: hide file paths and codebase identity
                              from the model, so a run demonstrates DISCOVERY
                              rather than recall of a codebase it memorized.
  --propose-from-priors      --claim-locate: legacy path — the model names symbols
                              from its own knowledge instead of searching the
                              index. Only sound for codebases the model has seen;
                              useless on confidential code.
  --hunt                     --claim-locate: let the model drive its own search of
                              the symbol table (SEARCH / MEMBERS / CALLERS /
                              CALLEES / EXTRACT) over several rounds, instead of
                              the single fixed word search. Opt-in while its
                              measurement gate is open; the report states the tool
                              call count and warns if the model searched nothing.
  --no-hunt                  --claim-locate: force the single-search path off even
                              if --hunt is present.
  --per-element-select       --claim-locate: choose implementers with one model call
                             PER ELEMENT instead of one pooled call for all of them.
                             Measured trade: fewer, denser targets (on-crux 25% ->
                             53%) but worse recall on the crux symbol
                             (shouldStartPlayback 5/5 -> 3/6), so pooled is the
                             default. Kept for measurement, and for local runs where
                             a shorter target list is worth more than recall.
  --runs <n>                 --claim-locate: repeat the discovery+selection cycle n
                             times and keep every target ANY run proposed, tallied
                             as "Runs-found: N/n" in --targets-out. Each run votes;
                             a target n of n runs proposed is firmer evidence than
                             one proposed once. Identical --per-element-select
                             invocations lost an element group in 3 of 7 runs, so a
                             single run's target list is ONE SAMPLE. Cost is LINEAR
                             in n. Above one run the 24-target cap binds: the
                             least-voted targets are cut and the run reports how
                             many, so a cut result is a floor on what more runs
                             would find, not the whole of it. Discovery path only --
                             refused with --hunt and --propose-from-priors.
  --synonymize <claim>       HOF-b. Rewrite a claim's WORDING away from the vocabulary
                             a programmer would use, preserving the requirement and the
                             element split, so a corpus whose answers are already known
                             becomes a real test of retrieval. Takes inline text or
                             @file; one model call per limitation. Needs NO index and
                             cannot read one -- withholding the code is the mechanism.
                             Reports how much of the original vocabulary survived, and
                             warns when a rewrite changed too little to test anything.
                             NOT the reverse tool: it moves wording AWAY from code, not
                             toward it.
                             A CORPUS of claims — one claim per line, as written by
                             --pseudo-claims --claims-only — is rewritten claim by
                             claim, IN ORDER, each with its own re-split verdict.
                             Note the '@': a bare argument that does not look like
                             claim text is rejected, not synonymized as a claim.
  --synonymize-out <file>    --synonymize: write the result to <file> with a '#'
                             provenance block (engine, source, overlap). One limitation
                             per line for a single claim, so it feeds back in via
                             --elements; one CLAIM per line for a corpus, so it feeds
                             back into --synonymize or a retrieval run unchanged.
  --claims-per-line          --synonymize: read the input as a CORPUS, one claim per
                             line, even when it carries no format marker. Use for a
                             hand-made claims file.
  --single-claim             --synonymize: read the input as ONE claim even if it
                             looks like a corpus. Use for a claim that happens to
                             occupy a single line.
  --no-per-element           --claim-analyze: skip the per-element search arm and
                             use whole-claim retrieval alone (pre-arm behaviour).
  --per-element-n <n>        --claim-analyze: how many per-element candidates to add
                             beyond the whole-claim top-N. Default one per claim
                             element, capped at 12. Selection is round-robin by rank,
                             so the budget is spent on DISTINCT elements first — an
                             element with no implementer analyzed is an element
                             reported ABSENT. 0 disables the arm.
  --targets-out <file>       --claim-locate: write the located targets to <file>, with a
                             '#' provenance block (engine, model, index, claim, hunt
                             caps, command, checksum) that --claim-chart reports.
  --hunt-rounds <n>          --claim-locate: max model turns in the hunt (default 8).
  --hunt-calls <n>           --claim-locate: max tool calls in the hunt (default 24).
  --include-tests            --claim-locate: allow test/mock symbols as candidates
                              (excluded by default; a test exercising an element
                              is not the code implementing it).
  --claim-analyze <claim>    End-to-end patent claim analysis: extract terms, search,
                              analyze top matches. Takes @file.txt or inline text.
                              Direct-target mode: pass a FUNCTION (or FILE@FUNCTION)
                              plus --claim-text to element-map the claim against
                              that function, skipping retrieval.
  --claims-loop <chart.md>   #290 harness: fill empty chart cells + measure
                              draft<->retrieve agreement. Needs --candidates
                              <cand.lst> (the list the chart was drafted from)
                              and a model. Writes <chart>_looped.md. Anchored
                              element mapping fills cells (loop: provenance);
                              retrieval runs second with vocabulary-sponge
                              suppression; ABSENT-heavy + retrieval-silent
                              claims land in a "Needs redraft" section.
  --loop-k <n>               --claims-loop: group functions analyzed per claim,
                              namesake first (default 3).
  --sponge-t <n>             --claims-loop: a function hitting more than N claims'
                              searches is suppressed as a vocabulary sponge
                              (default 2).
  --loop-save-analyses       --claims-loop: save every raw per-anchor analysis
                              to <chart>_looped_analyses/ so fills can be
                              audited against the model's justification.
  --loop-redraft             --claims-loop: feed the analysis back to the
                              drafter (#290 convergence). Claims with an
                              ABSENT element (or the needs-redraft flag) get
                              ONE redraft cycle — PRESENT/PARTIAL element
                              language preserved verbatim, ABSENT elements
                              rewritten to describe the anchored code — then
                              re-analyzed; the redraft is kept only if
                              element coverage improves. Original prose is
                              preserved in the output for audit.
  Cost guard (cloud models)  --rank, --pseudo-claims drafting, and --claims-loop
                              print a projected cost up front and STOP if it
                              exceeds $2. --force proceeds anyway; the
                              CE_CLAIMS_COST_GUARD env var (USD) sets the
                              threshold. An actual-cost line prints at the end.
                              Local GGUF runs are free and never gated.
  --multisect-analyze <terms> Search for functions matching terms, analyze top hits.
                              Same term syntax as --multisect-search.
  --file-analyze <filepath>  Analyze an entire source file with LLM
  --mask-all                 Strip comments and mask string contents before sending to LLM
  --line-numbers             Include source line numbers in LLM prompt. Now the
                              DEFAULT for --claim-analyze, --multisect-analyze and
                              --analyze --with, whose prompts ask the model to cite
                              line numbers as evidence; supplying none made it
                              invent them. Still opt-in for plain --analyze and
                              --file-analyze, whose prompts don't ask.
  --no-line-numbers          Suppress source line numbers even on the paths where
                              they now default on (saves prompt tokens; the model
                              will then cite quotes, or fabricate line numbers).
  --force                    With --analyze / --file-analyze (Claude): bypass the
                             projected-cost guard. By default an analysis whose
                             estimated cost exceeds ~$0.50 is blocked with the
                             estimate shown; --force sends it anyway. Override the
                             threshold with the CE_ANALYZE_COST_GUARD env var.
                             Local (air-gapped) analysis has no cost guard.
  --with-digest              Prepend the --digest output (static-analysis facts:
                             identity, callers/callees, strings, breadcrumbs,
                             comments, dupes) to the --analyze prompt. Use to
                             A/B the effect of CodeExam-provided context on
                             local-LLM analysis quality. Composable with
                             --with <claim-text> and --mask-all.

DEDUP / DUPLICATES:
  --dupefiles <n>            Top N duplicate file groups by SHA1 hash
  --func-dupes <n>           Top N exact duplicate function groups (SHA1 body hash)
  --near-dupes <n>           Top N near-duplicate function groups (same name+size, different body)
  --struct-dupes <n>         Top N structural dupe groups (same structure, different names/values)
  --show-funcstring [name|hash]
                             Show the structural funcstring for a function,
                             found by name (substring) or by a struct/body
                             hash — 8+ hex chars, full or prefix, pairs with
                             --funcstr-hashes. Bare flag falls back to
                             struct-dupes results.
  --struct-diff <name>       Show word-hole differences between structural dupe variants
  --struct-diff-all <n>      One-line diff summaries for top N structural dupe groups
  --show-sources             (with --struct-diff-all / --string-call-diff-all) list each
                             variant's filepath:line so cross-codebase matches are visible
  --cross-source-only        (with *-diff-all) filter to clusters whose members span 2+
                             distinct sources — hides within-project duplicates
  --string-call-dupes <n>    Top N groups of functions sharing an EXACT string-call
                             fingerprint (distinctive string literals + called-name tokens).
                             Complements --struct-dupes: finds functions whose SEMANTIC
                             signature matches even when STRUCTURE has been reshaped
                             (e.g. by a bundler/minifier)
  --string-call-diff-all <n> Detailed string-call dupe output. Combines with --show-sources
                             and --cross-source-only.
  --cmp-string-call-dupes <s>  Jaccard SIMILARITY comparison (fuzzy). Find cross-source
                             function pairs whose fingerprints overlap by score ≥ s.
                             For deobfuscating bundled code against its source libraries.
                             Use --fingerprint-work / --fingerprint-ref to scope the two
                             sides; --fingerprint-min-tokens to reject tiny-fingerprint
                             functions; --show-tokens to display the shared tokens.
  --notable-funcstr-matches <n>
                             Top N "notable funcstring matches": groups of
                             functions sharing a structural funcstring whose
                             members are surprising (different names and/or
                             distant file paths) — the CLI form of the GUI's
                             Notable Funcstring Matches, using the same engine.
                             Options: --nf-min-lines <n> (default 3),
                             --nf-min-surprise <f> (peak threshold, default
                             0.5), --nf-sort <peak|mean|lines> (default peak),
                             --nf-tight (stricter structural hashing). Honors
                             --filter; -v lists each group's instances.
  --funcstr-hashes <min-lines>
                             Dump one tab-separated row per function at least
                             <min-lines> long: struct_hash, body_hash, lines,
                             name, filepath. Quiet, header-less output meant
                             for piping (awk/sort/join) — the primitive for
                             cross-index funcstring intersection. The
                             min-lines value is required. --fh-tight uses the
                             stricter structural hash. Summary goes to stderr;
                             stdout stays pure data.
  --funcstr-corpus <files>   Consume external funcstr-hashes file(s)
                             (comma-separated) as a reference corpus and
                             classify THIS index's functions by cross-product
                             document-frequency: COMMON (boilerplate seen across
                             many products), RARE-SHARED (rare structure shared
                             with a specific product — significant overlap),
                             NOVEL (not in the corpus). Handles both shapes:
                             "=== .index ===" sections (each a product) and
                             headerless files (whole file = one product). Tune
                             with --fc-common-df / --fc-rare-df; -v lists COMMON.
  --exclude-corpus <s>       With --funcstr-corpus: drop every corpus product
                             whose name contains <s> (case-sensitive) before
                             building the DF table. Use to exclude the target's
                             own family (e.g. --exclude-corpus openclaw) for an
                             honest cross-product comparison.
  --build-fp-renames [s]     Generate _FP_ rename-map entries for cross-source
                             fingerprint matches above score s (default 0.8). Same as
                             --build-fingerprint-renames. Accumulates with existing
                             _KW_/_CMD_/_NAME_/_IMPORT_ tiers (doesn't overwrite);
                             enforces bare-name-uniqueness safety; skips matches where
                             the work side already has a descriptive name. Writes
                             directly to <index>/rename_map.json. Use --dry-run to
                             preview without writing.
  --dry-run                  (with --build-fp-renames) show what would be written, don't
                             actually modify rename_map.json.
  --fp-classes               (with --build-fp-renames) also propose CLASS renames by
                             aggregating method-level matches. Class X gets renamed to
                             X_FP_RefClass when ≥2 methods of X match methods of RefClass
                             with avg score ≥ 0.8 AND coverage ≥ 50% of the smaller
                             class. Note: can mis-label subclasses (which inherit the
                             parent's methods) as the parent class — see source-code
                             comment for details. Easy to disable.
  --save-fingerprints <path> Compute fingerprints on the current index and write them
                             to a portable JSON file. No source code is saved — only
                             the fingerprint tokens + filepath/line metadata. The
                             saved file can later be passed to --load-fingerprints
                             against any other index, so reference libraries don't
                             need to be re-indexed alongside every working corpus.
  --load-fingerprints <path> Load a previously-saved fingerprints file. Loaded
                             functions augment the candidate pool for
                             --cmp-string-call-dupes / --build-fp-renames. May be
                             repeated to load multiple files. When combined with
                             --build-fp-renames, each loaded file is COPIED into
                             <indexPath>/fingerprints/ so the index becomes
                             self-contained; manifest.json there records the
                             applied_at + min_score for each application.
  --fingerprint-ref <patt>   (with --build-fp-renames or --cmp-string-call-dupes)
                             Restrict the REF side to sources whose label contains
                             any of the (comma-separated) patterns. Use to exclude
                             noisy reference sources — e.g., pass "zod,ajv" to match
                             against ONLY library-source fingerprints and ignore a
                             bundled cli.js-side entry that happened to be saved in
                             the same .fp.json file.
  --fingerprint-work <patt>  Same, but scoping the WORK side.
  --clean-fp                 (with --build-fp-renames) strip existing _FP_ suffixes
                             from rename_map.json BEFORE emitting new ones. Use to
                             back out a noisy _FP_ pass without hand-editing the
                             map. Non-_FP_ tiers (_KW_, _CMD_, _NAME_, _IMPORT_)
                             are preserved.

CONTENT ANALYSIS:
  --command-catalog          List CLI options, commands, switch/case branches, API
                             routes, and GUI actions discovered in the codebase
  --string-table [filter]    Show frequently-occurring string literals (alias: --strings)
                             Optional filter: substring or /regex/flags
  --breadcrumbs              Show telemetry/trace markers and event categories
                             (execution flow phases inferred from log/trace calls).
                             Combine with --verbose to expand each event
                             category into its full event list AND a per-
                             function rollup ("which functions emit which
                             events"). Combine with --filter PATTERN to
                             narrow to events whose name contains PATTERN.
  --file-bookends [N]        Show the first N and last N lines of each file
                             (default N=20). Entry points in minified bundles
                             are almost always at the top or tail of the file;
                             this gives a raw head+tail view with renames
                             applied. Combine with --filter PATTERN or
                             --include-path to narrow to specific files.
  --bundle-seams [FILE]      For minified/bundled JS files, detect the esbuild
                             module wrapper pattern and list each original-
                             source module's line range, kind (ESM/CJS), and
                             a content preview. Default: all large JS files
                             in the index. With FILE: only that pattern.
                             Honors --filter, --include-path, --exclude-path.
  --seam-verbose             With --bundle-seams: also scan each module body
                             for leaked source paths (node_modules/..., .js
                             files) and license headers. Slower but surfaces
                             module-to-original-package hints.
  --digest <funcspec>        Print a structured digest of a single function
                             that aggregates every mechanical signal CodeExam
                             can compute: identity, caller/callee counts,
                             distinctive + repeated strings, breadcrumbs,
                             comments, command-catalog cross-reference,
                             exact/near/structural dupes. Useful both as
                             human orientation and as LLM-analysis preamble.
                             Takes FUNCNAME or FILE@FUNCNAME.

BINARY ANALYSIS (Quasi-Source — see issue #76):
  --inspect-binary <target...>
                             Fast "what is this and where might I find related
                             source" report for native binaries. Detects file
                             format (PE/ELF/Mach-O), framework/bundler signatures
                             (Bun, Tauri, Electron, PyInstaller, pkg, nexe, Node
                             SEA, pure Rust), embedded source-locating hints (.obj/
                             SDK paths, git SHAs, GitHub URLs, MSVC/rustc versions),
                             PE imports/exports, code-signing, and PDB presence.
                             Symlinks are followed (realpathSync). <target> is one
                             or more paths, a quoted glob ("/usr/bin/*.exe", or
                             "**/*.so" for recursive), or @filelist. Pair with -v
                             to expand stdlib imports and show all hint matches.
  --extract-js-from-binary <path>
                             Detect the bundler used to produce a native
                             install binary (claude.exe, codex.exe, etc.)
                             and extract the embedded JavaScript to a
                             directory CodeExam can then index. Currently
                             supports: Bun standalone executables (bun
                             build --compile), including PE-signed
                             Windows builds where the bun trailer sits
                             before the Authenticode certificate. Future:
                             pkg, nexe, Node SEA, Tauri asset table,
                             Electron .asar.
  --output-dir <dir>         With --extract-js-from-binary: target
                             directory for extracted files. Default:
                             <binary-basename>.extracted/

EXAMPLES:
  node src/index.js --build-index ./my-project
  node src/index.js --extract-js-from-binary path/to/claude.exe
  node src/index.js --stats
  node src/index.js --fast "TODO"
  node src/index.js --functions "main"
  node src/index.js --functions --sort size
  node src/index.js --extract "build_index"
  node src/index.js --files-search "import" --max-results 50
  node src/index.js --callers "search_literal"
  node src/index.js --callees "main"
  node src/index.js --call-inventory                      # all external deps
  node src/index.js --call-inventory "send_data"          # single function
  node src/index.js --call-inventory --filter "SSL" -v    # filter + verbose
  node src/index.js --most-called 20 --defined-only --min-name-length 4
  node src/index.js --call-tree "build_index" --depth 3
  node src/index.js --call-tree "build_index" --mermaid
  node src/index.js --file-map --max-results 10
  node src/index.js --file-tree "main.py" --depth 3
  node src/index.js --hotspots 20
  node src/index.js --hot-folders 15
  node src/index.js --entry-points 20 --max-calls 1
  node src/index.js --gaps
  node src/index.js --domain-fns 20
  node src/index.js --classes
  node src/index.js --class-hotspots 15
  node src/index.js --index-path path/to/index --overview  # load an index, run a command
  node src/index.js -i --index-path path/to/index          # load an index, interactive REPL
  node src/index.js --gui                                  # browser GUI
  node src/index.js --analyze tls_connect --llm claude
  node src/index.js --analyze tls_connect --with @patent.txt --llm claude
  node src/index.js --claim-analyze @patent.txt --llm claude
  node src/index.js --multisect-analyze "encrypt;key;cipher" --llm claude
  node src/index.js --file-analyze crypto.c --llm claude --mask-all
`;
  console.log(filter ? filterHelp(usage, filter) : usage);
}
