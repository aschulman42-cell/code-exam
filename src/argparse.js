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

const VERSION = '0.1.0 (Node.js port)';


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
    multi_index: null,
    skip_semantic: true,
    use_tree_sitter: false,
    extensions: null,
    exclude_extensions: null,
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
    context: 3,
    verbose: false,
    full_path: false,
    filter: null,
    include_path: null,
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
    list_models: false,
    list_artifacts: false,
    list_kernels: false,
    list_multimodal: false,
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
    class_hotspots: null,
    discover_vocabulary: null,
    multisect_search: null,
    vocab_in: null,
    show_dupes: false,
    full_path: false,
    dedup: 'exact',

    // Phase 8a: Claim search (LLM-based term extraction)
    claim_search: null,
    claim_file: null,
    use_claude: false,
    llm: null,            // canonical: --llm <provider>; provider name ('claude', etc.)
    api_key: null,
    claim_model: null,
    model: null,          // canonical: --model <path>; unifies --claim-model + --analyze-model
    temperature: 0.0,
    show_prompt: false,
    vocab_tight: false,
    no_vocabulary: false,

    // Phase 8b: LLM analysis
    analyze: null,
    claim_analyze: null,
    multisect_analyze: null,
    file_analyze: null,
    analyze_model: null,
    analyze_context: null,
    mask_all: false,
    line_numbers: false,
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
  };

  // Definitions: [argName, type, aliases]
  // type: 'flag', 'value', 'optional_value', 'list'
  const defs = [
    ['build_index',          'value',          ['--build-index']],
    ['rebuild_functions',    'flag',           ['--rebuild-functions']],
    ['build_rename_map',     'flag',           ['--build-rename-map']],
    ['rename_min_lines',     'int',            ['--rename-min-lines']],
    ['file_bookends',        'optional_value', ['--file-bookends']],
    ['bundle_seams',         'optional_value', ['--bundle-seams']],
    ['seam_verbose',         'flag',           ['--seam-verbose']],
    ['digest',               'value',          ['--digest']],
    ['index_path',           'value',          ['--index-path']],
    ['multi_index',          'value',          ['--multi-index']],
    ['skip_semantic',        'flag',           ['--skip-semantic']],
    ['use_tree_sitter',      'flag',           ['--use-tree-sitter']],
    ['extensions',           'value',          ['--extensions']],
    ['exclude_extensions',   'value',          ['--exclude-extensions']],
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
    ['list_indexes',         'optional_value', ['--indexes'], ['--list-indexes']],

    ['max_results',          'int',            ['--max-results', '--max', '-n']],
    ['context',              'int',            ['--context']],
    ['verbose',              'flag',           ['--verbose', '-v']],
    ['full_path',            'flag',           ['--full-path']],
    ['filter',               'value',          ['--filter']],
    ['include_path',         'list',           ['--include-path']],
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
    ['list_models',          'flag',           ['--models'], ['--list-models']],
    ['list_artifacts',       'flag',           ['--artifacts'], ['--list-artifacts']],
    ['list_kernels',         'flag',           ['--kernels'], ['--list-kernels']],
    ['list_multimodal',      'flag',           ['--multimodal', '--vision'], ['--list-multimodal']],
    ['list_datasets',        'flag',           ['--datasets'], ['--list-datasets']],
    ['list_training',        'flag',           ['--training'], ['--list-training']],
    ['list_inference',       'flag',           ['--inference'], ['--list-inference']],
    ['list_llm_calls',       'flag',           ['--llm-calls'], ['--list-llm-calls']],
    ['list_tools',           'flag',           ['--tools'], ['--list-tools']],
    ['list_chains',          'flag',           ['--chains'], ['--list-chains', '--agents']],
    ['list_embeddings',      'flag',           ['--embeddings'], ['--list-embeddings', '--vectors']],
    ['list_structured_output', 'flag',         ['--structured-output'], ['--schemas', '--list-structured-output']],
    ['list_models_used',     'flag',           ['--models-used'], ['--list-models-used']],
    ['list_pipelines',       'flag',           ['--pipelines'], ['--list-pipelines', '--workflows']],
    ['class_hotspots',       'int',            ['--class-hotspots']],
    ['discover_vocabulary',  'int',            ['--vocabulary', '--vocab'], ['--discover-vocabulary']],
    ['multisect_search',     'value',          ['--multisect-search', '--multisect']],
    ['vocab_in',             'value',          ['--in']],
    ['show_dupes',           'flag',           ['--show-dupes']],

    // Phase 8a: claim search
    ['claim_search',         'value',          ['--claim-search']],
    ['claim_file',           'value',          ['--claim-file']],
    ['use_claude',           'flag',           [], ['--use-claude']],
    ['llm',                  'value',          ['--llm']],
    ['api_key',              'value',          ['--api-key']],
    ['model',                'value',          ['--model']],
    ['claim_model',          'value',          [], ['--claim-model', '--term-extract-model']],
    ['temperature',          'float',          ['--temperature']],
    ['show_prompt',          'flag',           ['--show-prompt']],
    ['vocab_tight',          'flag',           ['--vocab-tight']],
    ['no_vocabulary',        'flag',           ['--no-vocabulary', '--no-vocab']],

    // Phase 8b: LLM analysis
    ['analyze',              'value',          ['--analyze']],
    ['claim_analyze',        'value',          ['--claim-analyze']],
    ['multisect_analyze',    'value',          ['--multisect-analyze']],
    ['file_analyze',         'value',          ['--file-analyze']],
    ['analyze_model',        'value',          [], ['--analyze-model']],
    ['analyze_context',      'value',          ['--with', '--context-text']],
    ['mask_all',             'flag',           ['--mask-all']],
    ['line_numbers',         'flag',           ['--line-numbers']],
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

    // Handle --help
    if (token === '--help' || token === '-h' || token === '--usage') {
      printUsage();
      process.exit(0);
    }
    if (token === '--version') {
      console.log(`code-exam ${VERSION}`);
      process.exit(0);
    }

    // Handle --arg=value
    let eqValue = null;
    const eqIdx = token.indexOf('=');
    if (eqIdx > 0 && token.startsWith('--')) {
      eqValue = token.slice(eqIdx + 1);
      token = token.slice(0, eqIdx);
    }

    const def = aliasMap.get(token);
    if (!def) {
      // Unknown arg - skip (could be a positional or typo)
      if (token.startsWith('-')) {
        console.error(`Warning: Unknown option '${token}'`);
        const suggestion = suggestClosest(token, aliasMap);
        args._unknownFlags.push({ token, suggestion });
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
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
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
          // Consume all following non-flag tokens
          while (i < argv.length && !argv[i].startsWith('--')) {
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
  if (args.llm === 'claude') args.use_claude = true;
  if (args.claim_model && !args.model) args.model = args.claim_model;
  if (args.analyze_model && !args.model) args.model = args.analyze_model;
  if (args.model && !args.claim_model) args.claim_model = args.model;
  if (args.model && !args.analyze_model) args.analyze_model = args.model;
  if (args.follow_calls && args.deep === null) args.deep = '1';

  return args;
}


function printUsage() {
  console.log(`
code-exam - Air-Gapped Source Code Examination Tool (Node.js)
Version: ${VERSION}

USAGE:
  node src/index.js [options]

INDEX MANAGEMENT:
  --build-index <path>       Build index from directory, file, glob, or @filelist
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
  --index-path <path>        Path to index directory (default: .code_search_index)
  --multi-index @filelist    Alternative to --index-path: fan the rest of the
                             command across many indexes. @filelist holds one
                             index directory path per line; CodeExam runs the
                             command against each and concatenates the output
                             (per-index header, no aggregation). A run uses
                             either --index-path or --multi-index, not both.
  --skip-semantic            Skip semantic/embedding indexing (default)
  --use-tree-sitter          Use tree-sitter for function parsing
  --extensions <exts>        Comma-separated file extensions to index
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
  --indexes [path]           List available index directories
                             (deprecated alias: --list-indexes)

DISPLAY / FILTERING (query-time, does not affect index build):
  --max-results <n>          Maximum results to display (alias: --max) (default: 20)
  --context <n>              Context lines around matches (default: 3)
  -v, --verbose              Show extra detail
  --full-path                Show full file paths in output
  --filter <text>            Filter function listings by name
  --include-path <patterns>  Only include paths containing pattern(s)
  --exclude-path <patterns>  Exclude paths containing pattern(s)
  --exclude-tests            Exclude test files from callers/metrics results
  --dedup <mode>             Dedup mode: none, exact, structural

MODE:
  -i, --interactive          Start interactive REPL mode
                             (auto-enters if no command given and index exists)

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
  --prompt-catalog           Detect and display LLM prompts in the codebase:
                             system prompts ("You are..."), getSystemPrompt methods,
                             systemPrompt: properties, role:"system" messages, and
                             build*Prompt functions. Full text, no truncation — pipe
                             to a file and grep for keywords. (alias: --prompts)
  --llm-calls                LLM API calls (messages.create, ChatOpenAI, LlamaChatSession)
  --tools                    Tool defs / function-calling (@tool, input_schema, MCP, tool_use)
  --chains                   Chains/agents (LangChain/LangGraph/DSPy/CrewAI; framework-based only)
  --embeddings               Embeddings & vector search (FAISS/Chroma, similarity_search, distance)
  --structured-output        Structured output / schemas (with_structured_output, response_format, parsers)
  --inference                Local inference/generation (generate, no_grad, .predict)
  --training                 Training sites (PyTorch loop, Trainer, .fit)
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
  --llm <provider>           Select cloud LLM provider for term extraction /
                             analysis. Currently only 'claude' is recognized.
                             Requires the corresponding API key env var.
                             (deprecated alias: --use-claude → --llm claude)
  --api-key <key>            API key for the selected provider (overrides env var)
  --model <path.gguf>        Local GGUF model path for term extraction and
                             analysis. Replaces both --claim-model and
                             --analyze-model. If you genuinely need different
                             models for term-extraction vs. analysis, the
                             two old flags are still accepted.
  --temperature <float>      LLM temperature (default: 0.0)
  --show-prompt              Display the LLM prompt and exit (no API call)
  --vocab-tight              Also use codebase vocabulary for TIGHT term generation
                              (default: vocabulary only influences BROAD terms)
  --no-vocabulary            Disable codebase vocabulary in term extraction prompts
                              (alias: --no-vocab) For A/B testing vocabulary guidance.

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
  --claim-analyze <claim>    End-to-end patent claim analysis: extract terms, search,
                              analyze top matches. Takes @file.txt or inline text.
  --multisect-analyze <terms> Search for functions matching terms, analyze top hits.
                              Same term syntax as --multisect-search.
  --file-analyze <filepath>  Analyze an entire source file with LLM
  --mask-all                 Strip comments and mask string contents before sending to LLM
  --line-numbers             Include source line numbers in LLM prompt
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
  node src/index.js --interactive               # enter REPL
  node src/index.js --index-path path/to/index  # auto-enters REPL
  node src/index.js --analyze tls_connect --llm claude
  node src/index.js --analyze tls_connect --with @patent.txt --llm claude
  node src/index.js --claim-analyze @patent.txt --llm claude
  node src/index.js --multisect-analyze "encrypt;key;cipher" --llm claude
  node src/index.js --file-analyze crypto.c --llm claude --mask-all
`);
}
