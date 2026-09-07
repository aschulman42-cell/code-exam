// referenced-resources.js — aggregates the external surface: env vars, URLs, paths, subprocess commands, cloud config, model IDs
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * referenced-resources.js — the "external surface" of a codebase (#203).
 *
 * Aggregates the things the code POINTS TO but does not itself contain — URLs/
 * hosts, environment variables, filesystem paths, external commands, cloud/infra
 * config, and model IDs. This is high-signal orientation (what does this code
 * reach out to?) and is exactly the corpus-mechanical aggregation a code-grovel
 * can't cheaply assemble: it's scattered across thousands of call sites.
 *
 * Design: an AGGREGATOR, not a new detection silo. The net-new work is the
 * env/filesystem/subprocess/network literal scans below; cloud and models are
 * delegated to the existing detectors (`detectInfrastructure`, the index's
 * models-used data) so logic isn't duplicated (the drift that bit struct_dupes).
 */

import { _isNoiseDoc } from './vocabulary.js';
import { detectInfrastructure } from './stack-detectors.js';

const MAX_SITES = 6;       // sites recorded per distinct resource (bounds output)

// Net-new literal scanners. Each is [regex, valueGroupIndex]; the regex runs
// per line only when a cheap substring gate matched (see scan loop). Patterns
// cover the common languages CodeExam indexes (JS/TS, Python, Java, Go, Ruby,
// Rust, C/C++).
const RE_ENV = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,                 // JS  process.env.FOO
  /process\.env\[\s*['"]([^'"]+)['"]\s*\]/g,                 // JS  process.env['FOO']
  /os\.environ(?:\.get)?\(\s*['"]([^'"]+)['"]/g,             // Py  os.environ.get('FOO') / os.environ('FOO')
  /os\.environ\[\s*['"]([^'"]+)['"]\s*\]/g,                  // Py  os.environ['FOO']
  /os\.getenv\(\s*['"]([^'"]+)['"]/g,                        // Py  os.getenv('FOO')
  /(?:^|[^.\w])getenv\(\s*['"]([^'"]+)['"]/g,                // C   getenv("FOO")
  /System\.getenv\(\s*['"]([^'"]+)['"]/g,                    // Java
  /os\.Getenv\(\s*['"]([^'"]+)['"]/g,                        // Go
  /(?:std::)?env::var(?:_os)?\(\s*['"]([^'"]+)['"]/g,        // Rust
  /ENV\[\s*['"]([^'"]+)['"]\s*\]/g,                          // Ruby ENV['FOO']
];

// URLs (and ws/grpc). Capture the whole URL; host is derived afterward.
const RE_URL = /\b((?:https?|wss?|ftp|grpc):\/\/[^\s'"`)<>\]]+)/g;

// Filesystem detection scans path-like string LITERALS anywhere — not just
// direct fs-call arguments. Call-anchoring (readFileSync('x')) was too strict:
// it missed the most important references, e.g. a `"resources/worklist.json"`
// literal assigned to a var or passed through `path.join` (#203 iterate). Any
// quoted token is classified by `_looksLikePath`.
// Match a quoted string, pairing each quote with its OWN type via a backreference
// (\1). A plain `['"`]...['"`]` cross-matches when quote types are adjacent
// (e.g. `require('fs').readFileSync("./x")` paired the `'` with the next `"`,
// orphaning the path). Captures the inner text in group 2.
const RE_QUOTED = /(['"`])((?:(?!\1).){1,300})\1/g;
// Source-module extensions are imports (internal structure), not external
// resources — excluded to cut import noise. Data/config/asset extensions are
// what an examiner wants (worklist.json, .env, settings.yaml, …). This gates
// BARE filenames (no path separator): a separator-bearing path with any
// non-source extension is already accepted, but a bare `"foo.ext"` must clear
// this allow-list to avoid flagging prose. Template / prompt-asset extensions
// (jinja2, mustache, …) are included so bare references like
// `quirks_dir / "ai_welfare_poisoning.jinja2"` register as referenced files
// (they were silently dropped before — the literal IS present, just bare).
const _SOURCE_EXTS = new Set('js jsx ts tsx mjs cjs py rb go rs java c cc cpp cxx h hpp hh cs php swift kt scala m mm'.split(' '));
const _DATA_EXTS = new Set(('json yaml yml toml ini env cfg conf config xml csv tsv sqlite db sql lock pem key crt cert log txt md sh bash bat ps1 html htm css scss proto graphql properties plist '
  + 'jinja2 j2 jinja tmpl tpl mustache hbs handlebars ejs liquid njk twig erb haml').split(' '));

function _looksLikePath(v) {
  if (v.includes('://')) return false;                 // URL → belongs to network
  if (/[\s%{}<>*?]/.test(v)) return false;             // prose / format / template / glob
  if (!/[A-Za-z0-9]{2,}/.test(v)) return false;        // pure separators / escapes ("\n\n", "//", "../", "\\")
  if (/:/.test(v) && !/^[A-Za-z]:[\\/]/.test(v)) return false; // mid-string colon — CORBA IDL ids (IDL:omg.org/…:1.0), "x:y"; allow only C:\ drive
  const hasSep = v.includes('/') || v.includes('\\');
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(v);
  let ext = m ? m[1].toLowerCase() : null;
  if (ext && /^\d+$/.test(ext)) ext = null;            // purely-numeric "extension" is a version (e.g. …:1.0), not a file type
  if (ext && _SOURCE_EXTS.has(ext)) return false;      // source import, not a resource
  if (hasSep) {
    if (ext) return true;                              // separated path with a (non-source) extension
    // separated, no extension: require a path-anchored shape so prose like
    // "and/or" doesn't qualify.
    return /^(\.{0,2}\/|\/|~\/|[A-Za-z]:[\\/])/.test(v) || (v.match(/[\/\\]/g) || []).length >= 2 || v.endsWith('/');
  }
  // bare filename: a recognized data/config/asset extension AND a real basename
  // char before the dot (so a bare ".db" fragment doesn't qualify).
  return ext != null && _DATA_EXTS.has(ext) && /[\w-]\.[A-Za-z0-9]{1,8}$/.test(v);
}

const RE_SUBPROC = [
  /(?:child_process\.)?(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"]([^'"]+)['"]/g, // Node
  /subprocess\.(?:run|call|Popen|check_output|check_call)\(\s*\[?\s*['"]([^'"]+)['"]/g,                // Py
  /os\.system\(\s*['"]([^'"]+)['"]/g,                        // Py os.system
  /(?:^|[^.\w])system\(\s*['"]([^'"]+)['"]/g,                // C system()
];

function _hostOf(url) {
  const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

// Trimmed source line, for showing each site's specifics (e.g. the full
// `spawn('git', ['status','--porcelain'])`) in the drill-down, since the
// captured value is only the first string arg.
function _snip(line) { return line.trim().slice(0, 200); }

// Accumulate one finding into a Map<value, {value, count, sites}>.
function _add(map, value, fp, lineNo, snippet) {
  if (!value) return;
  let e = map.get(value);
  if (!e) { e = { value, count: 0, sites: [] }; map.set(value, e); }
  e.count++;
  if (e.sites.length < MAX_SITES) e.sites.push({ filepath: fp, line: lineNo, snippet: snippet || '' });
}

function _runAll(regexes, line, fp, lineNo, map, accept) {
  for (const re of regexes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) { if (!accept || accept(m[1])) _add(map, m[1], fp, lineNo, _snip(line)); }
  }
}

// Embedded SQL: a string literal that BEGINS with a SQL statement keyword.
// Multi-word forms (DELETE FROM, CREATE TABLE) keep false positives down; bare
// SELECT at string start is SQL-specific enough. #202: surfacing embedded SQL is
// the request — and CE was already (mis-)capturing it under "External commands"
// because `db.exec("SELECT …")` collides with `child_process.exec`. Route SQL
// here instead, and exclude it from subprocess.
function _looksLikeSql(v) {
  // Require real SQL shape, not a bare leading keyword — "Select channel
  // (QuickStart)" (UI prose) starts with SELECT but has no FROM, so it must not
  // qualify. SELECT⇒needs FROM; UPDATE⇒needs SET; INSERT/DELETE⇒need INTO/FROM
  // + an identifier.
  return /^\s*(SELECT\s+[\w*"`(][\s\S]*?\bFROM\b|INSERT\s+INTO\s+[\w"`[(]|UPDATE\s+[\w"`.\[\]]+\s+SET\b|DELETE\s+FROM\s+[\w"`[]|CREATE\s+(?:(?:TEMP|TEMPORARY|UNIQUE)\s+)?(?:TABLE|INDEX|VIEW|DATABASE|TRIGGER|SCHEMA)\b|ALTER\s+TABLE\s|DROP\s+(?:TABLE|INDEX|VIEW)\b|WITH\s+[\w"`]+\s+AS\s*\(\s*SELECT\b|REPLACE\s+INTO\s+[\w"`[]|TRUNCATE\s+TABLE\b)/i.test(v);
}
// Normalize SQL for dedup/display: collapse whitespace, cap length.
function _sqlKey(v) { return v.replace(/\s+/g, ' ').trim().slice(0, 140); }

// Sort a value-map into a ranked array (by count desc, then value).
function _ranked(map) {
  return [...map.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Extract the codebase's referenced external resources.
 * @param {object} idx loaded CodeSearchIndex
 * @returns {{network:Array, env:Array, filesystem:Array, subprocess:Array, cloud:Array, models:Array, stats:object}}
 */
export function extractReferencedResources(idx) {
  const envMap = new Map(), urlMap = new Map(), fsMap = new Map(), subMap = new Map(), sqlMap = new Map();

  for (const [fp, lines] of idx.fileLines) {
    if (_isNoiseDoc(fp, null)) continue;       // skip vendored / generated / test / minified trees
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length > 2000) continue; // skip blank/huge (minified) lines
      const lineNo = i + 1;
      const low = line.toLowerCase();
      // Cheap substring gates so we only run regexes on plausibly-relevant lines.
      if (low.includes('env')) _runAll(RE_ENV, line, fp, lineNo, envMap);
      if (low.includes('://')) {
        RE_URL.lastIndex = 0;
        let m;
        while ((m = RE_URL.exec(line)) !== null) {
          const url = m[1].replace(/[.,;:'")\]]+$/, '');  // trim trailing punctuation
          _add(urlMap, url, fp, lineNo, _snip(line));
        }
      }
      if (line.includes("'") || line.includes('"') || line.includes('`')) {
        RE_QUOTED.lastIndex = 0;
        let m;
        while ((m = RE_QUOTED.exec(line)) !== null) {
          const v = m[2];
          if (_looksLikeSql(v)) _add(sqlMap, _sqlKey(v), fp, lineNo, _snip(line));   // embedded SQL (#202)
          else if (_looksLikePath(v)) _add(fsMap, v, fp, lineNo, _snip(line));       // filesystem path
        }
      }
      if (low.includes('spawn') || low.includes('exec') || low.includes('system(') ||
          low.includes('subprocess') || low.includes('popen'))
        _runAll(RE_SUBPROC, line, fp, lineNo, subMap, v => !_looksLikeSql(v)); // SQL → sql category, not subprocess
    }
  }

  const network = _ranked(urlMap).map(e => ({ ...e, host: _hostOf(e.value) }));
  const env = _ranked(envMap);
  // Tag each fs entry: a 'file' has an extension on its basename; a 'path' is
  // an extension-less path (directory, or a route fragment like /__worklist/…).
  // Lets the UI separate named files (the valuable part) from the long tail.
  const filesystem = _ranked(fsMap).map(e => ({
    ...e,
    kind: (/\.[A-Za-z0-9]{1,8}$/.test(e.value) && !e.value.endsWith('/')) ? 'file' : 'path',
  }));
  const subprocess = _ranked(subMap);
  const sql = _ranked(sqlMap);

  // Reuse: cloud/infra via stack-detectors (aggregate rows by cell+kind).
  let cloud = [];
  try {
    const infra = detectInfrastructure(idx);
    const cMap = new Map();
    for (const r of (infra.rows || [])) {
      const key = `${r.cell}|${r.kind}`;
      let e = cMap.get(key);
      if (!e) { e = { cell: r.cell, kind: r.kind, tag: r.tag, count: 0, sites: [] }; cMap.set(key, e); }
      e.count++;
      if (e.sites.length < MAX_SITES) e.sites.push({ filepath: r.filepath, line: r.line });
    }
    cloud = [...cMap.values()].sort((a, b) => b.count - a.count || a.cell.localeCompare(b.cell));
  } catch { /* infra detection is best-effort */ }

  // Reuse: model IDs the code loads/calls, if the index exposes them.
  let models = [];
  try {
    if (typeof idx.listModelsUsed === 'function') {
      models = (idx.listModelsUsed() || []).map(m => ({
        model: m.model, access: m.access, count: m.count,
      }));
    }
  } catch { /* models-used is best-effort */ }

  // Distinct hosts (derived summary for the network category).
  const hosts = [...new Set(network.map(n => n.host).filter(Boolean))];

  return {
    network, env, filesystem, subprocess, sql, cloud, models,
    stats: {
      network: network.length, hosts: hosts.length, env: env.length,
      filesystem: filesystem.length, subprocess: subprocess.length,
      sql: sql.length, cloud: cloud.length, models: models.length,
    },
    hosts,
  };
}
