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
 * Parse process.argv and return a normalized args object.
 * @returns {object}
 */
export function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {
    // Index management
    build_index: null,
    rebuild_functions: false,
    index_path: '.code_search_index',
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
    dedup: 'none',
    min_terms: '0',

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
    api_key: null,
    claim_model: null,
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

    // Content analysis
    command_catalog: false,
    string_table: null,
    breadcrumbs: false,

    // Track which flags were explicitly set (for dispatch logic)
    _explicit: new Set(),
  };

  // Definitions: [argName, type, aliases]
  // type: 'flag', 'value', 'optional_value', 'list'
  const defs = [
    ['build_index',          'value',          ['--build-index']],
    ['rebuild_functions',    'flag',           ['--rebuild-functions']],
    ['index_path',           'value',          ['--index-path']],
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
    ['list_files',           'optional_value', ['--list-files']],
    ['show_file',            'value',          ['--show-file']],
    ['list_functions',       'optional_value', ['--list-functions']],
    ['list_functions_alpha',  'flag',          ['--list-functions-alpha']],
    ['list_functions_size',   'flag',          ['--list-functions-size']],
    ['extract',              'value',          ['--extract']],
    ['scan_extensions',      'value',          ['--scan-extensions']],
    ['index_extensions',     'flag',           ['--index-extensions']],
    ['list_indexes',         'optional_value', ['--list-indexes']],

    ['max_results',          'int',            ['--max-results', '-n']],
    ['context',              'int',            ['--context']],
    ['verbose',              'flag',           ['--verbose', '-v']],
    ['full_path',            'flag',           ['--full-path']],
    ['filter',               'value',          ['--filter']],
    ['include_path',         'list',           ['--include-path']],
    ['exclude_path',         'list',           ['--exclude-path']],
    ['dedup',                'value',          ['--dedup']],
    ['min_terms',            'value',          ['--min-terms']],

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
    ['list_classes',         'flag',           ['--list-classes']],
    ['class_hotspots',       'int',            ['--class-hotspots']],
    ['discover_vocabulary',  'int',            ['--discover-vocabulary', '--vocabulary', '--vocab']],
    ['multisect_search',     'value',          ['--multisect-search', '--multisect']],
    ['vocab_in',             'value',          ['--in']],
    ['show_dupes',           'flag',           ['--show-dupes']],
    ['full_path',            'flag',           ['--full-path']],
    ['dedup',                'value',          ['--dedup']],

    // Phase 8a: claim search
    ['claim_search',         'value',          ['--claim-search']],
    ['claim_file',           'value',          ['--claim-file']],
    ['use_claude',           'flag',           ['--use-claude']],
    ['api_key',              'value',          ['--api-key']],
    ['claim_model',          'value',          ['--claim-model', '--term-extract-model']],
    ['temperature',          'float',          ['--temperature']],
    ['show_prompt',          'flag',           ['--show-prompt']],
    ['vocab_tight',          'flag',           ['--vocab-tight']],
    ['no_vocabulary',        'flag',           ['--no-vocabulary', '--no-vocab']],

    // Phase 8b: LLM analysis
    ['analyze',              'value',          ['--analyze']],
    ['claim_analyze',        'value',          ['--claim-analyze']],
    ['multisect_analyze',    'value',          ['--multisect-analyze']],
    ['file_analyze',         'value',          ['--file-analyze']],
    ['analyze_model',        'value',          ['--analyze-model']],
    ['analyze_context',      'value',          ['--with', '--context-text']],
    ['mask_all',             'flag',           ['--mask-all']],
    ['line_numbers',         'flag',           ['--line-numbers']],
    ['claim_text',           'value',          ['--claim-text']],

    // Phase 9: Extended extraction
    ['follow_calls',         'flag',           ['--follow-calls']],
    ['deep',                 'optional_value', ['--deep']],
    ['comments_only',        'flag',           ['--comments-only']],

    // Phase 4: dedup
    ['dupefiles',            'int',            ['--dupefiles']],
    ['func_dupes',           'int',            ['--func-dupes']],
    ['near_dupes',           'int',            ['--near-dupes']],
    ['struct_dupes',         'int',            ['--struct-dupes']],
    ['show_funcstring',      'optional_value', ['--show-funcstring']],
    ['struct_diff',          'value',          ['--struct-diff']],
    ['struct_diff_all',      'int',            ['--struct-diff-all']],

    // New: content analysis
    ['command_catalog',      'flag',           ['--command-catalog']],
    ['string_table',         'optional_value', ['--string-table', '--strings']],
    ['breadcrumbs',          'flag',           ['--breadcrumbs']],
  ];

  // Build alias lookup
  const aliasMap = new Map(); // alias -> { name, type }
  for (const [name, type, aliases] of defs) {
    for (const alias of aliases) {
      aliasMap.set(alias, { name, type });
    }
  }

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
      }
      i++;
      continue;
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
  --rebuild-functions        Rebuild function index from loaded file contents
  --index-path <path>        Path to index directory (default: .code_search_index)
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

BROWSE:
  --stats                    Show index statistics
  --list-files [pattern]     List indexed files (optional filter)
  --show-file <pattern>      Display entire file contents
  --list-functions [pattern] List functions (optional filter)
  --list-functions-alpha     List all functions alphabetically
  --list-functions-size      List all functions sorted by size
  --extract <spec>           Extract function source: FUNCTION or FILE@FUNCTION
  --follow-calls             With --extract: also dump source of all callees
  --deep [N]                 Same as --follow-calls, optionally N levels deep (default: 1)
  --comments-only            With --extract: show only full-line comments from the code
  --scan-extensions <path>   Count file extensions in a directory
  --index-extensions         Count file extensions in current index
  --list-indexes [path]      List available index directories

DISPLAY / FILTERING (query-time, does not affect index build):
  --max-results <n>          Maximum results to display (default: 20)
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
  --depth <n>                Depth for transitive callers (default: 1) or call-tree (default: 3)
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
  --hotspots <n>             Top N structurally important functions (calls x log2(lines))
  --hot-folders <n>          Top N directories by aggregated hotspot score
  --entry-points <n>         Top N uncalled functions (sorted by size)
  --max-calls <n>            Max call count for entry-points (default: 0 = never called)
  --gaps [n]                 Find suspicious dead code (defined, no callers, not entry-point)
  --domain-fns <n>           Top N domain-specific functions (score / sqrt(name defs))
  --list-classes             List all classes with method counts/sizes
  --class-hotspots <n>       Top N classes by aggregated method hotspot score
  --discover-vocabulary <n>  Top N domain-specific tokens by TF-IDF score (aliases: --vocabulary, --vocab)
  --multisect-search <terms> Multi-term intersection search (semicolon-separated terms)
                             Finds smallest scope (function/file/folder) containing all terms
                             Terms in /.../ are regex. Prefix with NOT or ! to negate.
                             Use --min-terms N for partial matching.
  --in <pattern>            Restrict vocabulary scan to files whose path matches pattern
  --show-dupes               Show file duplicate paths in output

CLAIM SEARCH (LLM-based patent claim analysis):
  --claim-search <text>      Extract search terms from patent claim text (or @file.txt)
  --claim-file <path>        Read patent claim text from file
  --use-claude               Use Claude API for term extraction (requires ANTHROPIC_API_KEY)
  --api-key <key>            Anthropic API key (overrides ANTHROPIC_API_KEY env var)
  --claim-model <path.gguf>  Use local GGUF model for term extraction (alias: --term-extract-model)
  --temperature <float>      LLM temperature (default: 0.0)
  --show-prompt              Display the LLM prompt and exit (no API call)
  --vocab-tight              Also use codebase vocabulary for TIGHT term generation
                              (default: vocabulary only influences BROAD terms)
  --no-vocabulary            Disable codebase vocabulary in term extraction prompts
                              (alias: --no-vocab) For A/B testing vocabulary guidance.

LLM ANALYSIS:
  --analyze <function>       Analyze a function with LLM ("what does this do?")
  --with <text>              Context text for --analyze (patent claim, description, etc.)
                              Analyze will explain the code in relation to this text.
                              Supports @file.txt syntax to read from file.
  --claim-analyze <claim>    End-to-end patent claim analysis: extract terms, search,
                              analyze top matches. Takes @file.txt or inline text.
  --multisect-analyze <terms> Search for functions matching terms, analyze top hits.
                              Same term syntax as --multisect-search.
  --file-analyze <filepath>  Analyze an entire source file with LLM
  --analyze-model <path.gguf> Path to local GGUF model for analysis (air-gap safe)
  --mask-all                 Strip comments and mask string contents before sending to LLM
  --line-numbers             Include source line numbers in LLM prompt
  --claim-text <text>        Patent claim text for --claim-analyze (or @file.txt)

DEDUP / DUPLICATES:
  --dupefiles <n>            Top N duplicate file groups by SHA1 hash
  --func-dupes <n>           Top N exact duplicate function groups (SHA1 body hash)
  --near-dupes <n>           Top N near-duplicate function groups (same name+size, different body)
  --struct-dupes <n>         Top N structural dupe groups (same structure, different names/values)
  --show-funcstring [name]   Show structural funcstring for a function (or for struct-dupes results)
  --struct-diff <name>       Show word-hole differences between structural dupe variants
  --struct-diff-all <n>      One-line diff summaries for top N structural dupe groups

EXAMPLES:
  node src/index.js --build-index ./my-project
  node src/index.js --stats
  node src/index.js --fast "TODO"
  node src/index.js --list-functions "main"
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
  node src/index.js --list-classes
  node src/index.js --class-hotspots 15
  node src/index.js --interactive               # enter REPL
  node src/index.js --index-path path/to/index  # auto-enters REPL
  node src/index.js --analyze tls_connect --use-claude
  node src/index.js --analyze tls_connect --with @patent.txt --use-claude
  node src/index.js --claim-analyze @patent.txt --use-claude
  node src/index.js --multisect-analyze "encrypt;key;cipher" --use-claude
  node src/index.js --file-analyze crypto.c --use-claude --mask-all
`);
}
