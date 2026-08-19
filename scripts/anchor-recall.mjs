#!/usr/bin/env node
/**
 * scripts/anchor-recall.mjs — HOF-c. Score CE's retrieval against the anchors
 * a pseudo-claim run already grounded.
 *
 * Usage:
 *   node scripts/anchor-recall.mjs --expected <anchors.json>
 *                                  --orig <dir> --syn <dir> [--detail N]
 *
 * <dir> holds per-claim --claim-search outputs named orig_NN.out / syn_NN.out,
 * as produced by sr_gh_claim_pairs/search_pairs.bat.
 *
 * A VALIDATION HARNESS, NOT A CLI COMMAND. Scoring CE's retrieval against a key
 * CE itself generated is circular as a customer feature; it belongs beside
 * rank-eval.mjs and claim-selftest.mjs, not in `ce --help`.
 *
 * SCORED ON CE'S OWN GRANULARITY LADDER. claim-search emits four ranked lists --
 * FUNCTION, CLASS, FILE, FOLDER -- so "how close did retrieval get" is already
 * expressed by which list an anchor appears in. An earlier prototype invented a
 * parallel tier scheme AND parsed only three of the four sections; it scored
 * sr_gh at 5% while `FSDPEngine` sat at CLASS rank #1 with 12/12 terms. Use the
 * tool's own ladder; do not invent one.
 *
 * WHAT THE LADDER EXPOSES, and why a single number will not do:
 *
 *   corpus          fn   class  file  folder   "reached"
 *   sr_gh (orig)     7      93    13       0   113/135 (84%)
 *   CodeExam (orig) 10      38    48       0    96/121 (79%)
 *
 * 84% and 5% are both true of the same run. The high number is "found the right
 * class"; function-level recall is 5-8%. Key anchors are METHODS and retrieval
 * finds the enclosing CLASS -- a lead, not a citation.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LADDER = ['fn', 'class', 'file', 'folder'];
const SECTION = /^=== (FUNCTION|CLASS|FILE|FOLDER)-level/;
const HIT = /^\s*\[(\d+)\]\s+(\S+)\s+\((.+?)\)\s+\[(\d+)\/(\d+)(?:\s+terms)?\]\s+IDF:([\d.]+)/;
// FOLDER rows have no parenthesized meta -- `[1] path/  [11/12 terms, 85 files] IDF:38.7`
// -- where FUNCTION / CLASS / FILE all carry one (`(736 lines)`, `(25 methods, 555 lines)`).
// Collapsing all four into one regex silently dropped every folder row; the parse-gap
// assertion in parseGaps() is what surfaced it, on a run whose SCORE was unaffected
// because folder is the last rung and no anchor ever reached it.
const HIT_FOLDER = /^\s*\[(\d+)\]\s+(\S+)\s+\[(\d+)\/(\d+)\s+terms,[^\]]*\]\s+IDF:([\d.]+)/;

/**
 * Parse one claim-search output into four ranked lists.
 *
 * TWO PASSES. The output contains a TIGHT pass and a BROAD pass, each restarting
 * ranks at [1]; a FUNCTION header opens a pass. Best (lowest) rank across passes
 * is used and the pass recorded, because a rank is only comparable within its own
 * pass.
 *
 * PARSE COVERAGE IS ASSERTED, NOT ASSUMED. `headers` counts the section headers
 * seen; a section whose header appears but whose entry list comes back empty is a
 * PARSER FAILURE, reported as such. A zero means "not found" OR "not parsed", and
 * only the control's implausibility distinguished them last time.
 */
export function parseSearchOutput(txt) {
  const out = { fn: [], class: [], file: [], folder: [] };
  const headers = { fn: 0, class: 0, file: 0, folder: 0 };
  let sec = null, pass = 0;
  for (const l of String(txt).split(/\r?\n/)) {
    const h = SECTION.exec(l);
    if (h) {
      const k = { FUNCTION: 'fn', CLASS: 'class', FILE: 'file', FOLDER: 'folder' }[h[1]];
      if (k === 'fn') pass += 1;
      sec = k; headers[k] += 1;
      continue;
    }
    if (!sec) continue;
    if (sec === 'folder') {
      const fm = HIT_FOLDER.exec(l);
      if (fm) out.folder.push({ rank: +fm[1], name: fm[2], meta: '', cov: +fm[3], of: +fm[4], idf: +fm[5], pass });
      continue;
    }
    const m = HIT.exec(l);
    if (m) out[sec].push({ rank: +m[1], name: m[2], meta: m[3], cov: +m[4], of: +m[5], idf: +m[6], pass });
  }
  return { lists: out, headers };
}

/** Sections whose header was present but which yielded no parsed entries. */
export function parseGaps({ lists, headers }) {
  return LADDER.filter((k) => headers[k] > 0 && lists[k].length === 0);
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/[.][.][.]/g, '');
export const enclosingClass = (fn) => (String(fn).includes('::') ? String(fn).split('::')[0] : null);

function best(list, ok) {
  let b = null;
  for (const e of list) if (ok(e) && (!b || e.rank < b.rank)) b = e;
  return b;
}

/** Best entry per rung for one key anchor. */
export function reach(lists, a) {
  if (!lists) return {};
  const want = norm(a.file);
  const c = enclosingClass(a.func);
  return {
    fn: best(lists.fn, (e) => e.name === a.func
      || (!String(a.func).includes('::') && e.name.endsWith('::' + a.func))),
    class: c ? best(lists.class, (e) => e.name === c) : null,
    file: best(lists.file, (e) => {
      const g = norm(e.name) || norm(e.meta);
      return g && (want.endsWith(g) || want.includes(g));
    }),
    folder: best(lists.folder, (e) => {
      const g = norm(e.name);
      return g && want.includes(g.replace(/[/]$/, ''));
    }),
  };
}

export const tierOf = (r) => LADDER.find((k) => r && r[k]) || null;

/** Distinct anchors, and the distinct classes they belong to. */
export function independence(grounded) {
  const anchors = new Set(), classes = new Set(), files = new Set();
  for (const a of grounded) {
    anchors.add(a.file + '@' + a.func);
    files.add(a.file);
    const c = enclosingClass(a.func);
    if (c) classes.add(a.file + '@' + c);
  }
  return { anchors: anchors.size, classes: classes.size, files: files.size };
}

/**
 * Reasons a claim cannot be scored. Each is COUNTED IN THE DENOMINATOR and
 * LISTED BY NAME -- never silently averaged in.
 */
export function unscoreable(claim) {
  if (claim.truncated) return 'truncated (drafted text cut off; ANCHORS block severed)';
  if (!claim.grounded || !claim.grounded.length) return 'no grounded anchors';
  return null;
}


// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const L = (s, w) => String(s).slice(0, w).padEnd(w);
const R = (s, w) => String(s).padStart(w);
const pct = (a, b) => (100 * a / Math.max(b, 1)).toFixed(0) + '%';
const pad2 = (n) => String(n).padStart(2, '0');

function readRun(dir, prefix, n) {
  const f = path.join(dir, prefix + '_' + pad2(n) + '.out');
  if (!fs.existsSync(f)) return null;
  const txt = fs.readFileSync(f, 'utf8');
  // An error page is not a result. A --claim-search artifact is tens of KB; the
  // shell redirect creates the file before ce runs, so "exists" never meant
  // "worked".
  if (txt.length < 4000) return null;
  return parseSearchOutput(txt);
}

export function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const expected = arg('--expected'), orig = arg('--orig'), syn = arg('--syn');
  const detail = arg('--detail') ? Number(arg('--detail')) : null;

  // THE CONTROL IS MANDATORY. Recall on the synonymized claim alone is
  // uninterpretable: an anchor missing from BOTH was never reachable by this
  // retrieval path under any wording, and says nothing about paraphrase.
  if (!expected || !orig || !syn) {
    console.error('usage: node scripts/anchor-recall.mjs --expected <anchors.json> --orig <dir> --syn <dir> [--detail N]');
    console.error('');
    console.error('  --orig is the CONTROL and is required. Synonymized recall without it');
    console.error('  cannot distinguish "paraphrase defeated retrieval" from "retrieval never');
    console.error('  found this code under any wording".');
    return 2;
  }

  const key = JSON.parse(fs.readFileSync(expected, 'utf8'));
  const tot = { k: 0, o: {}, s: {} };
  for (const t of LADDER) { tot.o[t] = 0; tot.s[t] = 0; }
  let anyO = 0, anyS = 0;
  const skipped = [], missing = [], gaps = [];
  let indepAnchors = 0, indepClasses = 0;

  console.log(L('clm', 3) + ' ' + L('label', 32) + ' ' + R('keys', 4) + ' ' + R('cls', 4)
    + ' ' + R('ORIG fn/cls/file/fold', 22) + ' ' + R('SYN fn/cls/file/fold', 22));
  console.log('-'.repeat(92));

  for (const c of key.claims) {
    const why = unscoreable(c);
    if (why) { skipped.push(c.n + ': ' + why); continue; }
    const o = readRun(orig, 'orig', c.n), s = readRun(syn, 'syn', c.n);
    if (!o || !s) { missing.push(String(c.n)); continue; }
    for (const [tag, p] of [['orig', o], ['syn', s]]) {
      for (const g of parseGaps(p)) gaps.push('claim ' + c.n + ' ' + tag + ': ' + g.toUpperCase() + ' header present, 0 entries parsed');
    }
    const seen = new Set(), uniq = [];
    for (const a of c.grounded) {
      const k = a.file + '@' + a.func;
      if (!seen.has(k)) { seen.add(k); uniq.push(a); }
    }
    const ind = independence(c.grounded);
    indepAnchors += ind.anchors; indepClasses += ind.classes;
    const co = { fn: 0, class: 0, file: 0, folder: 0 };
    const cs = { fn: 0, class: 0, file: 0, folder: 0 };
    const det = [];
    for (const a of uniq) {
      const ro = reach(o.lists, a), rs = reach(s.lists, a);
      const to = tierOf(ro), ts = tierOf(rs);
      if (to) { co[to] += 1; anyO += 1; }
      if (ts) { cs[ts] += 1; anyS += 1; }
      det.push({ func: a.func, to, ts, ro, rs });
    }
    tot.k += uniq.length;
    for (const t of LADDER) { tot.o[t] += co[t]; tot.s[t] += cs[t]; }
    const fmt = (x) => x.fn + '/' + x.class + '/' + x.file + '/' + x.folder;
    console.log(pad2(c.n) + ' ' + L(c.label || '', 32) + ' ' + R(uniq.length, 4) + ' '
      + R(ind.classes, 4) + ' ' + R(fmt(co), 22) + ' ' + R(fmt(cs), 22));
    if (detail === c.n) {
      for (const d of det) {
        const rr = (t, x) => (t ? t + '#' + x[t].rank + '(p' + x[t].pass + ')' : 'MISS');
        console.log('     ' + L(d.func, 44) + ' orig ' + L(rr(d.to, d.ro), 16) + ' syn ' + rr(d.ts, d.rs));
      }
    }
  }

  console.log('-'.repeat(92));
  const fmtT = (x) => LADDER.map((t) => t + ' ' + x[t]).join('  ');
  console.log('key anchors scored: ' + tot.k);
  console.log('ORIGINAL  reached ' + anyO + ' (' + pct(anyO, tot.k) + ')   [' + fmtT(tot.o) + ']');
  console.log('SYNONYM   reached ' + anyS + ' (' + pct(anyS, tot.k) + ')   [' + fmtT(tot.s) + ']');
  console.log('');
  console.log('Counts are BEST rung per anchor, so the columns PARTITION the reached');
  console.log('anchors: one found at function level is not also counted at class level.');
  console.log('A high total with a low `fn` column is a lead, not a citation -- the key');
  console.log('anchors are methods and retrieval found the enclosing class.');

  // ANCHOR INDEPENDENCE. `[class] X` candidate groups make anchors correlated by
  // construction: sr_gh claim 10 is 14 anchors that are 14 methods of one class,
  // so a single class-level hit scores 14. asus-CC measured the same shape on
  // Gemma3 -- 196 grounded anchors resolving to 70 distinct functions.
  if (indepClasses) {
    console.log('');
    console.log('INDEPENDENCE: ' + indepAnchors + ' distinct anchors across ' + indepClasses
      + ' distinct classes (' + (indepAnchors / Math.max(indepClasses, 1)).toFixed(1) + ' per class).');
    console.log('  Anchors sharing a class are NOT independent retrieval events.');
  }

  // Every exclusion is named. A rate whose denominator hides its skips is how
  // the candidate-cap number misled in the first place.
  if (skipped.length) {
    console.log('');
    console.log('UNSCOREABLE (' + skipped.length + '), excluded and counted:');
    for (const s of skipped) console.log('  claim ' + s);
  }
  if (missing.length) console.log('\nno usable search output for claim(s): ' + missing.join(', '));

  // A parse gap is a PARSER FAILURE, not a score of zero.
  if (gaps.length) {
    console.log('');
    console.log('*** PARSE GAPS (' + gaps.length + ') — these are parser failures, NOT zero recall:');
    for (const g of gaps) console.log('  ' + g);
    return 1;
  }
  return 0;
}

if (import.meta.url === 'file://' + process.argv[1] || process.argv[1] === new URL(import.meta.url).pathname
    || process.argv[1] && process.argv[1].endsWith('anchor-recall.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
