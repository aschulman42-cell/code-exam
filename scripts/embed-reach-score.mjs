// Copyright 2026 CodeExam contributors — https://github.com/aschulman42-cell/code-exam
// Licensed under the Apache License, Version 2.0.
//
// issue-322-codebert-reach-test: does a code-text embedding model (CodeBERT,
// UniXcoder) put a litigant's cited functions within reach of a claim element,
// and how does that compare with CodeExam's name search over the same names?
//
// A MEASUREMENT, not a feature. The vectors come from scripts/embed-reach.py
// (Python, torch + transformers); this script scores them with no model:
//
//   node scripts/embed-reach-score.mjs --work <dir> [--only id,id] [--models codebert,unixcoder]
//        [--reprs name,sig,body] [--render docs/embedding-reach.md]
//
// For each filing × repository with vectors under <work>/embed/, every claim
// element is scored against every symbol by cosine; a cited name's rank is its
// best across the claim's elements; hits within 25 (CodeExam's window) and 60
// (the widened cap) and the median rank are reported per filing and pooled.
// Two comparators on the same names: CodeExam's name search with the tier-1
// logs' predicted words (recomputed the way classify_chosen.mjs does), and a
// shuffled control (each claim paired with another filing's elements). Agreement
// with a party's cited names, never correctness.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- .npy reader (float32, C order; what embed-reach.py writes) ------------
export function readNpy(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error(`${file}: not an .npy file`);
  const major = buf[6];
  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const dataStart = (major === 1 ? 10 : 12) + headerLen;
  const header = buf.toString('latin1', major === 1 ? 10 : 12, dataStart);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1] === 'True';
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (descr !== '<f4' || fortran) throw new Error(`${file}: expected little-endian float32 C-order, got ${descr}${fortran ? ' fortran' : ''}`);
  const n = shape.reduce((a, b) => a * b, 1);
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset + dataStart, buf.byteOffset + dataStart + n * 4));
  return { shape, data };
}

export function row(m, i) {
  const d = m.shape[1];
  return m.data.subarray(i * d, (i + 1) * d);
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Cosine of one element against every symbol row (vectors are unit-norm, so a dot). */
export function scoresFor(elementVec, symbols) {
  const out = new Float32Array(symbols.shape[0]);
  for (let i = 0; i < symbols.shape[0]; i++) out[i] = dot(elementVec, row(symbols, i));
  return out;
}

/** 1-based rank of index `idx` in `scores` (ties count as worse: strictly-greater rows + 1). */
export function rankOf(scores, idx) {
  const v = scores[idx];
  let better = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i] > v) better++;
  return better + 1;
}

export function bestRank(ranks) {
  return ranks.length ? Math.min(...ranks) : Infinity;
}

export function hitsAt(ranks, k) {
  return ranks.filter((r) => r <= k).length;
}

/** Median over EVERY name; a name the method never ranked (Infinity) sorts last, so a
 *  method that reaches fewer than half the names has an infinite median, printed as "beyond". */
export function median(values) {
  const v = values.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** The shuffled control: every filing paired with another's elements, never itself. */
export function controlPairing(ids) {
  if (ids.length < 2) return new Map();
  return new Map(ids.map((id, i) => [id, ids[(i + 1) % ids.length]]));
}

/** The bare name a reach file records, against a symbol table key "file@Qual::name". */
export function bareOf(name) {
  return String(name || '').replace(/^.*@/, '').replace(/^.*::/, '');
}

/** Rows of the symbol key list whose bare name equals the cited name. */
export function citedRows(keys, citedName) {
  const out = [];
  for (let i = 0; i < keys.length; i++) if (bareOf(keys[i]) === citedName) out.push(i);
  return out;
}

/** Best rank of a cited name: over its rows and over the claim's elements. */
export function bestRankForName(scoreRows, rows) {
  let best = Infinity;
  for (const scores of scoreRows) for (const r of rows) best = Math.min(best, rankOf(scores, r));
  return best;
}

export function summarize(ranks) {
  return { names: ranks.length, hits25: hitsAt(ranks, 25), hits60: hitsAt(ranks, 60), median: median(ranks) };
}

/** Pool per-filing rank lists into one summary. */
export function rollup(perFiling) {
  const all = [];
  for (const f of perFiling) all.push(...(f.ranks || []));
  return summarize(all);
}

// ---- CodeExam comparator: the name search with the tier-1 words ---------
export function parseElementWords(log) {
  const words = new Map();
  for (const w of String(log).matchAll(/^  element (\d+): words \[([^\]]*)\]/gm)) {
    words.set(Number(w[1]), w[2].split(',').map((s) => s.trim()).filter(Boolean));
  }
  return words;
}

// ---- render ----------------------------------------------------------------
export const BEGIN = '<!-- embed-reach:begin -->';
export const END = '<!-- embed-reach:end -->';

const fmt = (x) => (x == null ? '—' : x === Infinity ? 'beyond the list' : String(Math.round(x * 10) / 10));

export function renderReach(results) {
  const out = [];
  const { generatedAt, device, models, reprs, filings, pooled } = results;
  out.push(`_Generated ${generatedAt}; vectors from \`scripts/embed-reach.py\` on ${device || 'an unrecorded device'};`
    + ` scored by \`scripts/embed-reach-score.mjs\` with no model call. ${filings.length} filing-repository`
    + ` pair(s), ${pooled.names} cited names reachable in their indexes._`);
  out.push('');
  out.push('**Pooled over every cited name** (a name\'s rank is its best across the claim\'s elements):');
  out.push('');
  out.push('| method | representation | names | within 25 | within 60 | median rank |');
  out.push('|---|---|---|---|---|---|');
  for (const m of models) {
    for (const r of reprs) {
      const s = pooled.methods[`${m}:${r}`];
      if (s) out.push(`| ${m} | ${r} | ${s.names} | ${s.hits25} | ${s.hits60} | ${fmt(s.median)} |`);
    }
  }
  if (pooled.methods.codeexam) {
    const s = pooled.methods.codeexam;
    out.push(`| CodeExam name search | predicted words | ${s.names} | ${s.hits25} | ${s.hits60} | ${fmt(s.median)} |`);
  }
  if (pooled.methods['control:codeexam']) {
    const s = pooled.methods['control:codeexam'];
    out.push(`| shuffled control (CodeExam name search) | another claim's predicted words | ${s.names} | ${s.hits25} | ${s.hits60} | ${fmt(s.median)} |`);
  }
  // One control row per model and representation, each over the same names as
  // the method it controls for; populations differ by representation.
  for (const m of models) {
    for (const r of reprs) {
      const s = pooled.methods[`control:${m}:${r}`];
      if (s) out.push(`| shuffled control (${m}, ${r}) | another claim's elements | ${s.names} | ${s.hits25} | ${s.hits60} | ${fmt(s.median)} |`);
    }
  }
  const pf = results.pooledFull;
  if (pf && pf.names && pf.names < pooled.names) {
    out.push('');
    out.push(`**Like for like, over the ${pf.names} names whose indexes carry every representation**`
      + ` (${[...new Set(pf.filings)].join(', ')}):`);
    out.push('');
    out.push('| method | representation | names | within 25 | within 60 | median rank |');
    out.push('|---|---|---|---|---|---|');
    for (const m of models) for (const r of reprs) {
      const s = pf.methods[`${m}:${r}`];
      if (s) out.push(`| ${m} | ${r} | ${s.names} | ${s.hits25} | ${s.hits60} | ${fmt(s.median)} |`);
    }
    if (pf.methods.codeexam) {
      const s = pf.methods.codeexam;
      out.push(`| CodeExam name search | predicted words | ${s.names} | ${s.hits25} | ${s.hits60} | ${fmt(s.median)} |`);
    }
    if (pf.methods['control:codeexam']) {
      const s = pf.methods['control:codeexam'];
      out.push(`| shuffled control (CodeExam name search) | another claim's predicted words | ${s.names} | ${s.hits25} | ${s.hits60} | ${fmt(s.median)} |`);
    }
    for (const m of models) for (const r of reprs) {
      const s = pf.methods[`control:${m}:${r}`];
      if (s) out.push(`| shuffled control (${m}, ${r}) | another claim's elements | ${s.names} | ${s.hits25} | ${s.hits60} | ${fmt(s.median)} |`);
    }
  }
  out.push('');
  out.push('**Per filing** (within 25 / within 60 / median, per method):');
  out.push('');
  const cols = [];
  for (const m of models) for (const r of reprs) cols.push(`${m}:${r}`);
  cols.push('codeexam');
  out.push(`| filing | repository | names | ${cols.map((c) => c.replace(':', ' ')).join(' | ')} |`);
  out.push(`|---|---|---|${cols.map(() => '---').join('|')}|`);
  for (const f of filings) {
    const cells = cols.map((c) => { const s = f.methods[c]; return s ? `${s.hits25} / ${s.hits60} / ${fmt(s.median)}` : '—'; });
    out.push(`| ${f.id} | ${f.repo} | ${f.names} | ${cells.join(' | ')} |`);
  }
  out.push('');
  out.push('**Runtime per index** (from the embedder\'s log; the device decides it):');
  out.push('');
  out.push('| index | symbols | device | model | representation | seconds |');
  out.push('|---|---|---|---|---|---|');
  for (const r of results.runtimes || []) out.push(`| ${r.index} | ${r.symbols} | ${r.device} | ${r.model} | ${r.repr || '—'} | ${fmt(r.seconds)} |`);
  if (results.missing && results.missing.length) {
    out.push('');
    out.push(`_Not yet embedded (${results.missing.length}): ${results.missing.join(', ')}._`);
  }
  return out.join('\n');
}

export function spliceBetweenMarkers(text, body) {
  const a = text.indexOf(BEGIN); const b = text.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error('markers not found');
  return `${text.slice(0, a + BEGIN.length)}\n${body}\n${text.slice(b)}`;
}

// ---- main ------------------------------------------------------------------
function arg(name, dflt) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; }

async function main() {
  const work = arg('--work');
  if (!work) { console.error('--work <dir> is required'); process.exitCode = 1; return; }
  const only = (arg('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const models = (arg('--models', 'codebert,unixcoder')).split(',').map((s) => s.trim()).filter(Boolean);
  const reprs = (arg('--reprs', 'name,sig,body')).split(',').map((s) => s.trim()).filter(Boolean);
  const renderTo = arg('--render', null);
  const embedDir = path.join(work, 'embed');
  const manifest = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8'));
  const cands = Array.isArray(manifest.candidates) ? manifest.candidates : Object.values(manifest.candidates || {});

  const { CodeSearchIndex } = await import(pathToFileURL(path.join(ROOT, 'src/core/CodeSearchIndex.js')).href);
  const { buildSymbolTable } = await import(pathToFileURL(path.join(ROOT, 'src/core/symbol-verify.js')).href);
  const { searchSymbolsByWords, elementOwnWords } = await import(pathToFileURL(path.join(ROOT, 'src/commands/claim-locate.js')).href);

  const pairs = [];
  for (const c of cands) {
    if (only.length && !only.includes(c.id)) continue;
    for (const r of c.repos || []) {
      const indexKey = `${r.org}__${r.repo}__${String(r.resolvedRef || r.ref || '').slice(0, 7)}`;
      pairs.push({ id: c.id, repo: `${r.org}/${r.repo}`, indexKey, indexPath: path.join(work, 'indexes', indexKey) });
    }
  }
  const ids = [...new Set(pairs.map((p) => p.id))];
  const control = controlPairing(ids);
  const filings = []; const missing = []; const runtimes = [];
  const elementsOf = (id, model) => {
    const dir = path.join(embedDir, 'claims', id);
    const f = path.join(dir, model, 'elements.npy');
    if (!fs.existsSync(f)) return null;
    return { vecs: readNpy(f), texts: JSON.parse(fs.readFileSync(path.join(dir, 'elements.json'), 'utf8')) };
  };
  const logFile = path.join(embedDir, 'log.jsonl');
  if (fs.existsSync(logFile)) {
    for (const l of fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) {
      try { const j = JSON.parse(l); if (j.index) runtimes.push(j); } catch { /* skip */ }
    }
  }
  let device = null;
  for (const p of pairs) {
    const idir = path.join(embedDir, 'index', p.indexKey);
    const keysFile = path.join(idir, 'keys.json');
    if (!fs.existsSync(keysFile)) { missing.push(`${p.id} ${p.repo}`); continue; }
    const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    const reachFile = path.join(work, 'out', p.id, `reach_${p.indexKey}.json`);
    if (!fs.existsSync(reachFile)) { missing.push(`${p.id} ${p.repo} (no reach file)`); continue; }
    const reach = JSON.parse(fs.readFileSync(reachFile, 'utf8'));
    const cited = [...new Set(((reach.functions && reach.functions.present) || []).map((f) => f.symbol || f.name))];
    const rowsByName = new Map(cited.map((n) => [n, citedRows(keys, n)]).filter(([, rows]) => rows.length));
    const filing = { id: p.id, repo: p.repo, index: p.indexKey, names: rowsByName.size, methods: {}, ranksBy: {} };
    for (const m of models) {
      const el = elementsOf(p.id, m);
      if (!el) continue;
      for (const r of reprs) {
        const vf = path.join(idir, m, `${r}.npy`);
        if (!fs.existsSync(vf)) continue;
        const sym = readNpy(vf);
        const scoreRows = [];
        for (let e = 0; e < el.vecs.shape[0]; e++) scoreRows.push(scoresFor(row(el.vecs, e), sym));
        const ranks = [...rowsByName.values()].map((rows) => bestRankForName(scoreRows, rows));
        filing.methods[`${m}:${r}`] = summarize(ranks); filing.ranksBy[`${m}:${r}`] = ranks;
        // The shuffled control: another filing's elements against this index.
        const other = control.get(p.id);
        const oel = other ? elementsOf(other, m) : null;
        if (oel) {
          const orows = []; for (let e = 0; e < oel.vecs.shape[0]; e++) orows.push(scoresFor(row(oel.vecs, e), sym));
          const cranks = [...rowsByName.values()].map((rows) => bestRankForName(orows, rows));
          filing.methods[`control:${m}:${r}`] = summarize(cranks); filing.ranksBy[`control:${m}:${r}`] = cranks;
        }
        device = device || (runtimes.find((x) => x.index === p.indexKey) || {}).device || null;
      }
    }
    // CodeExam's name search with the tier-1 blind run's predicted words, and
    // the same search with ANOTHER filing's words against this index: the
    // shuffled control the name search owes as much as the embeddings do
    // (Andrew, 2026-10-24: if it finds claim A's elements in codebase X, make
    // sure it does not also find an unrelated claim B's there).
    const blindOf = (id, indexKey) => {
      const dir = path.join(work, 'out', id);
      if (!id || !fs.existsSync(dir)) return null;
      const logs = fs.readdirSync(dir).filter((f) => /^tier1_.*_blind_.*\.log$/.test(f));
      const lf = (indexKey && logs.find((f) => f.includes(indexKey))) || logs[0];
      if (!lf) return null;
      const words = parseElementWords(fs.readFileSync(path.join(dir, lf), 'utf8'));
      const tf = path.join(dir, lf.replace(/\.log$/, '.targets.txt'));
      const elemText = new Map();
      if (fs.existsSync(tf)) for (const e of fs.readFileSync(tf, 'utf8').matchAll(/^# Element (\d+): (.*)$/gm)) elemText.set(Number(e[1]), e[2]);
      return words.size ? { words, elemText } : null;
    };
    const rankWith = (symbols, src) => {
      const lists = [];
      for (const [el, ws] of src.words) lists.push(searchSymbolsByWords(symbols, ws, { limit: 60, ownWords: elementOwnWords(src.elemText.get(el) || '', ws) }));
      return [...rowsByName.keys()].map((name) => {
        let best = Infinity;
        for (const hits of lists) {
          const i = hits.findIndex((h) => h && h.sym && bareOf(h.sym.name) === name);
          if (i >= 0) best = Math.min(best, i + 1);
        }
        return best;
      });
    };
    const own = blindOf(p.id, p.indexKey);
    if (own && fs.existsSync(p.indexPath)) {
      try {
        const symbols = buildSymbolTable(new CodeSearchIndex({ indexPath: p.indexPath }));
        const ranks = rankWith(symbols, own);
        filing.methods.codeexam = summarize(ranks); filing.ranksBy.codeexam = ranks;
        const other = blindOf(control.get(p.id), null);
        if (other) {
          const cranks = rankWith(symbols, other);
          filing.methods['control:codeexam'] = summarize(cranks); filing.ranksBy['control:codeexam'] = cranks;
        }
      } catch (e) { filing.codeexamError = e.message; }
    }
    filings.push(filing);
  }
  // The '101 reachability fixture: its externally named implementer sets against
  // the ExoPlayer index, with CodeExam's pinned predicted words as the comparator.
  //   --fixture <json> --fixture-index <path> --fixture-index-key <key> --fixture-claim <id>
  const fixturePath = arg('--fixture', null);
  if (fixturePath) {
    const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const fkey = arg('--fixture-index-key', 'AndroidX_Media_ExoPlayer3');
    const fclaim = arg('--fixture-claim', '8752101');
    const fidx = arg('--fixture-index', path.join(ROOT, '.AndroidX_Media_ExoPlayer3'));
    const kf = path.join(embedDir, 'index', fkey, 'keys.json');
    if (!fs.existsSync(kf)) missing.push(`fixture ${fkey}`);
    else {
      const keys = JSON.parse(fs.readFileSync(kf, 'utf8'));
      const sets = {};
      for (const e of fx.expected_reachable || []) for (const s of e.sources || []) (sets[s] = sets[s] || new Set()).add(e.symbol);
      sets.union = new Set((fx.expected_reachable || []).map((e) => e.symbol));
      // CodeExam's comparator from the fixture's pinned words, once per element.
      let ceLists = null;
      if (fx.element_words && fs.existsSync(fidx)) {
        try {
          const symbols = buildSymbolTable(new CodeSearchIndex({ indexPath: fidx }));
          const texts = JSON.parse(fs.readFileSync(path.join(embedDir, 'claims', fclaim, 'elements.json'), 'utf8'));
          ceLists = Object.entries(fx.element_words).map(([el, ws]) =>
            searchSymbolsByWords(symbols, ws, { limit: 60, ownWords: elementOwnWords(texts[Number(el) - 1] || '', ws) }));
        } catch (e) { missing.push(`fixture comparator: ${e.message}`); }
      }
      for (const [setName, names] of Object.entries(sets)) {
        const rowsByName = new Map([...names].map((n) => [n, citedRows(keys, n)]).filter(([, rows]) => rows.length));
        const filing = { id: `fixture:${setName}`, repo: 'androidx/media (ExoPlayer 3)', index: fkey, names: rowsByName.size, methods: {}, ranksBy: {} };
        for (const m of models) {
          const el = elementsOf(fclaim, m);
          if (!el) continue;
          for (const r of reprs) {
            const vf = path.join(embedDir, 'index', fkey, m, `${r}.npy`);
            if (!fs.existsSync(vf)) continue;
            const sym = readNpy(vf);
            const scoreRows = []; for (let e = 0; e < el.vecs.shape[0]; e++) scoreRows.push(scoresFor(row(el.vecs, e), sym));
            const ranks = [...rowsByName.values()].map((rows) => bestRankForName(scoreRows, rows));
            filing.methods[`${m}:${r}`] = summarize(ranks); filing.ranksBy[`${m}:${r}`] = ranks;
          }
        }
        // No CodeExam column for the fixture: its symbols are class names whose
        // methods carry the class as a qualifier, and its own test measures reach
        // through the full retrieval (navigation and content arm), which the name
        // search alone understates. The page cites the fixture test's floors.
        void ceLists;
        filing.fixture = true;
        filings.push(filing);
      }
    }
  }
  // The harness pairs pool; the fixture's three overlapping sets do not (their
  // rows stay in the per-filing table).
  const pooledFilings = filings.filter((f) => !f.fixture);
  const pooled = { names: pooledFilings.reduce((n, f) => n + f.names, 0), methods: {} };
  const methodKeys = new Set(); for (const f of pooledFilings) for (const k of Object.keys(f.methods)) methodKeys.add(k);
  for (const k of methodKeys) pooled.methods[k] = rollup(pooledFilings.map((f) => ({ ranks: f.ranksBy[k] || [] })));
  // Like for like: every method over the names whose filings carry every
  // representation, so a 37-name body score is not read against a 70-name
  // name score. Unreached ranks are Infinity here and null in the JSON.
  const full = pooledFilings.filter((f) => f.names > 0 && models.every((m) => reprs.every((r) => f.methods[`${m}:${r}`])));
  const pooledFull = { names: full.reduce((n, f) => n + f.names, 0), filings: full.map((f) => f.id), methods: {} };
  for (const k of methodKeys) pooledFull.methods[k] = rollup(full.map((f) => ({ ranks: f.ranksBy[k] || [] })));
  const results = { generatedAt: new Date().toISOString(), device, models, reprs, filings, pooled, pooledFull, runtimes, missing,
    _ranks: 'in ranksBy a null rank means the method\'s list did not contain the name (Infinity before JSON)' };
  fs.mkdirSync(embedDir, { recursive: true });
  fs.writeFileSync(path.join(embedDir, 'reach-scores.json'), `${JSON.stringify(results, null, 2)}\n`);
  const body = renderReach(results);
  if (renderTo) {
    const page = fs.readFileSync(renderTo, 'utf8');
    fs.writeFileSync(renderTo, spliceBetweenMarkers(page, body));
    console.error(`[embed-reach] rendered into ${renderTo}`);
  } else {
    console.log(body);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exitCode = 1; });
}
