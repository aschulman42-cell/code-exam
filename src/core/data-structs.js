/**
 * data-structs.js — #194 Data Structures detector.
 *
 * CodeExam surfaces functions and classes as ranked lists, but had no view for
 * the *data-shape* constructs that dominate systems code: struct / enum / union
 * / typedef (C/C++), struct / enum / union / trait (Rust), type…struct /
 * interface (Go), interface / enum / type / record (TS/Java). Tree-sitter does
 * extract several of these — but tags them all as `class`, so they're
 * indistinguishable in the function index and the Classes accordion. This
 * detector finds them with language-aware definition patterns over the cached
 * file lines (works on existing indexes, no reindex), labels each with its
 * KIND, and ranks by reference count so the central types (e.g. Bram's
 * `struct TurnState`) surface at the top instead of being buried.
 *
 * Noise-excluded (#172/#187): vendored / minified / test trees are skipped via
 * `_isNoiseDoc`, the same gate the vocabulary uses.
 */
import { _isNoiseDoc } from './vocabulary.js';

// Definition patterns per language family. Each entry: { kindIdx, nameIdx } tells
// which capture group is the kind keyword vs the type name.
const _LANG_BY_EXT = {
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c', '.h': 'c', '.cpp': 'c', '.hpp': 'c', '.cc': 'c', '.cxx': 'c',
  '.hh': 'c', '.hxx': 'c', '.cu': 'c', '.cuh': 'c', '.m': 'c', '.mm': 'c',
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.java': 'java', '.kt': 'java', '.cs': 'java', '.swift': 'java',
};

// kind keyword + name; group order documented inline.
const _PATTERNS = {
  // pub struct Foo / enum Foo / union Foo / trait Foo
  rust: [{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|union|trait)\s+([A-Za-z_]\w*)/, kind: 1, name: 2 }],
  // type Foo struct { / type Foo interface {
  go: [{ re: /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/, kind: 2, name: 1 }],
  // tagged: struct Foo { | enum Foo : | union Foo;   and one-line typedef.
  c: [
    { re: /^\s*(struct|enum|union)\s+([A-Za-z_]\w*)\s*[{:;]/, kind: 1, name: 2 },
    { re: /^\s*typedef\s+(?:struct|enum|union)?\s*[^;{]*?\b([A-Za-z_]\w*)\s*;/, kind: 0, name: 1 }, // kind=0 → "typedef"
  ],
  // export interface Foo / enum Foo / type Foo =
  ts: [{ re: /^\s*(?:export\s+)?(?:declare\s+)?(interface|enum|type)\s+([A-Za-z_]\w*)/, kind: 1, name: 2 }],
  // enum Foo / interface Foo / record Foo (Java/Kotlin/C#/Swift-ish)
  java: [{ re: /^\s*(?:(?:public|private|protected|internal|sealed|static|final|abstract)\s+)*(enum|interface|record|struct|protocol)\s+([A-Za-z_]\w*)/, kind: 1, name: 2 }],
};

const _ext = (fp) => { const i = fp.lastIndexOf('.'); return i < 0 ? '' : fp.slice(i).toLowerCase(); };

/**
 * Extract data-structure definitions across the index — ONE entry per unique
 * name+kind. A struct defined in N files used to appear N times, inflating the
 * count on every surface (CLI, GUI, MCP).
 * @returns {Array<{name, kind, filepath, line, refs, fileCount,
 *   instances: Array<{filepath, line}>}>} ranked by fileCount desc (file
 *   spread — a type touched by many files is more central than a locally-hot
 *   one), then refs desc. filepath/line are the primary (first) instance so
 *   pre-dedup consumers keep working.
 */
export function extractDataStructures(idx, { topN = 0 } = {}) {
  const defs = [];           // { name, kind, filepath, line }
  const nameSet = new Set();

  for (const [fp, lines] of idx.fileLines) {
    if (_isNoiseDoc(fp, null)) continue; // vendored/minified/test — skip (#172/#187)
    const lang = _LANG_BY_EXT[_ext(fp)];
    if (!lang) continue;
    const pats = _PATTERNS[lang];
    // C idiom: `typedef struct {` … `} Foo;` — the name is on the closing line.
    let pendingTypedefAggregate = false;
    let typedefBraceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (lang === 'c') {
        if (/^\s*typedef\s+(struct|enum|union)\b[^;]*\{\s*$/.test(ln)) {
          pendingTypedefAggregate = true; typedefBraceDepth = 1; continue;
        }
        if (pendingTypedefAggregate) {
          // #251: track brace depth so a NESTED `} member;` doesn't end the
          // aggregate early (recording the member as a false typedef and dropping
          // the real tag). Only the brace that returns to depth 0 closes it.
          for (const ch of ln) { if (ch === '{') typedefBraceDepth++; else if (ch === '}') typedefBraceDepth--; }
          if (typedefBraceDepth <= 0) {
            // Closing line: grab the first tag name after `}` — handles `} Foo;`,
            // `} *PFoo;`, and multi-name `} Foo, *PFoo;` (takes the first, Foo).
            const m = ln.match(/^\s*\}\s*\*?\s*([A-Za-z_]\w*)/);
            if (m) { defs.push({ name: m[1], kind: 'typedef', filepath: fp, line: i + 1 }); nameSet.add(m[1]); }
            pendingTypedefAggregate = false;
          }
          continue;
        }
      }
      for (const p of pats) {
        const m = ln.match(p.re);
        if (m) {
          const kind = p.kind === 0 ? 'typedef' : m[p.kind];
          const name = m[p.name];
          if (name && name.length >= 2) { defs.push({ name, kind, filepath: fp, line: i + 1 }); nameSet.add(name); }
          break; // one definition per line
        }
      }
    }
  }

  if (!defs.length) return [];

  // Reference count: one pass over the corpus, tally word occurrences that match
  // a defined type name. The definition lines count too (consistent baseline).
  // This is what surfaces central types (widely referenced) over one-off ones.
  const refs = new Map();
  const wordRe = /[A-Za-z_]\w*/g;
  for (const [fp, lines] of idx.fileLines) {
    if (_isNoiseDoc(fp, null)) continue;
    for (const ln of lines) {
      let m;
      wordRe.lastIndex = 0;
      while ((m = wordRe.exec(ln)) !== null) {
        if (nameSet.has(m[0])) refs.set(m[0], (refs.get(m[0]) || 0) + 1);
      }
    }
  }

  // Collapse to ONE entry per unique name+kind, aggregating every definition
  // site into `instances` and counting distinct defining files (`fileCount`).
  // filepath/line stay populated with the primary (first-seen) instance for
  // consumers that predate the dedup.
  const byKey = new Map();
  for (const d of defs) {
    const key = `${d.name}|${d.kind}`;
    let e = byKey.get(key);
    if (!e) {
      e = { name: d.name, kind: d.kind, filepath: d.filepath, line: d.line,
            refs: refs.get(d.name) || 0, instances: [], _seen: new Set() };
      byKey.set(key, e);
    }
    const ikey = `${d.filepath}|${d.line}`;
    if (!e._seen.has(ikey)) { e._seen.add(ikey); e.instances.push({ filepath: d.filepath, line: d.line }); }
  }
  const out = [];
  for (const e of byKey.values()) {
    e.fileCount = new Set(e.instances.map(i => i.filepath)).size;
    delete e._seen;
    out.push(e);
  }

  // Rank by file spread first (ranking by raw refs floated ubiquitous
  // primitives like WORD/DWORD over the real structs), then refs, then name.
  out.sort((a, b) => b.fileCount - a.fileCount || b.refs - a.refs || a.name.localeCompare(b.name));
  return topN > 0 ? out.slice(0, topN) : out;
}
