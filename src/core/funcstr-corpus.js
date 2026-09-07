// funcstr-corpus.js — loads external funcstr-hash dumps as a DF corpus, labeling functions common / rare-shared / novel
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * funcstr-corpus.js — consume external funcstr-hashes file(s) as a reference
 * corpus (#128). CE can GENERATE funcstr-hashes (#16) but not, until now, USE
 * them. A pile of `funcstr_hashes_*.txt` is a corpus we exploit two ways via a
 * cross-product DOCUMENT-FREQUENCY (DF) table over structural function hashes:
 *
 *   COMMON       — high DF (the same structure across many UNRELATED products):
 *                  generic boilerplate the examiner can skip.
 *   RARE-SHARED  — low DF in OTHER products: a rare structure shared with a
 *                  specific product is non-coincidental (copied code / shared
 *                  private lib / common authorship) — high signal.
 *   NOVEL        — not in the corpus: index-specific, OR boilerplate the corpus
 *                  does not yet cover (broaden the corpus to disambiguate).
 *
 * The match key is the STRUCTURAL hash (column 1 — SHA1 of the renaming-normalized
 * funcstring, structural-fingerprint.js), so it survives renaming / reformatting
 * (the same hash the index produces via ensureFuncHashes).
 *
 * Both file shapes are handled:
 *   - a file WITH `=== .index ===` section headers (new --multi-index output)
 *     → each section is a distinct product, named by the header;
 *   - a file WITHOUT headers (older dumps) → the whole file is ONE product,
 *     named by its filename.
 */
import fs from 'fs';

const SECTION_RE = /^===\s*(.+?)\s*===\s*$/;

export function loadFuncstrCorpus(filePaths, opts = {}) {
  const exclude = opts.exclude || null;            // case-sensitive substring: drop matching products
  const byHash = new Map();     // structHash -> Set<product>
  const meta = new Map();       // structHash -> {name, path}
  const products = new Set();
  const excludedProducts = new Set();
  let minLines = Infinity, rows = 0;
  for (const fp of filePaths) {
    let text;
    try { text = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    const fileProduct = fp.replace(/\\/g, '/').split('/').pop();
    let section = null;
    for (const line of text.split('\n')) {
      const h = line.match(SECTION_RE);
      if (h) { section = h[1]; continue; }
      if (!line) continue;
      const c = line.split('\t');
      if (c.length < 5) continue;                 // not a funcstr-hash row
      const hash = c[0];
      const lines = parseInt(c[2], 10) || 0;
      const product = section || fileProduct;      // headerless file => one product
      if (exclude && product.includes(exclude)) { excludedProducts.add(product); continue; }
      products.add(product);
      let s = byHash.get(hash); if (!s) { s = new Set(); byHash.set(hash, s); }
      s.add(product);
      // Keep ALL distinct names a hash carries across the corpus (capped) — enables
      // name recovery: a minified target name whose hash matches a readably-named
      // corpus function is de-obfuscated. names: Map(name -> count); path = first.
      let m = meta.get(hash);
      if (!m) { m = { names: new Map(), path: c[4] }; meta.set(hash, m); }
      if (m.names.has(c[3]) || m.names.size < 32) m.names.set(c[3], (m.names.get(c[3]) || 0) + 1);
      if (lines && lines < minLines) minLines = lines;
      rows++;
    }
  }
  return { byHash, meta, products, rows, excludedProducts: [...excludedProducts], minLines: isFinite(minLines) ? minLines : 1 };
}

/**
 * Classify a target index's functions against the corpus by OTHER-product DF
 * (the target index itself is excluded from the count if it appears in the
 * corpus, so being present in your own corpus doesn't read as "shared").
 *   currentFuncs: [{ hash, name, path, lines }]
 */
export function classifyAgainstCorpus(currentFuncs, corpus, opts = {}) {
  const commonDf = opts.commonDf ?? 5;
  const rareDf = opts.rareDf ?? 2;
  const self = opts.currentName || null;
  const r = { novel: [], common: [], rareShared: [], mid: [] };
  for (const f of currentFuncs) {
    const set = corpus.byHash.get(f.hash);
    if (!set) { r.novel.push(f); continue; }
    const others = self ? [...set].filter(p => p !== self) : [...set];
    const odf = others.length;
    if (odf === 0) { r.novel.push(f); continue; }   // only in the corpus via the target itself
    const row = { ...f, df: odf, products: others };
    if (odf >= commonDf) r.common.push(row);
    else if (odf <= rareDf) r.rareShared.push(row);
    else r.mid.push(row);
  }
  r.common.sort((a, b) => b.df - a.df || b.lines - a.lines);
  r.rareShared.sort((a, b) => a.df - b.df || b.lines - a.lines);  // rarest first
  r.mid.sort((a, b) => b.df - a.df);
  return r;
}
