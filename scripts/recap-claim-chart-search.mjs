// recap-claim-chart-search.mjs — find public claim charts that cite open-source code, and catalog what they cite
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// A litigated claim paired with the code a party charted it against is the real-world
// counterpart of the HOF self-test (docs/real-world-claim-charts.md). Public filings rarely
// carry code-level charts (those are served under protective orders), but where the accused
// product is itself open source the complaint, the contentions fight or an expert declaration
// sometimes cites a repository file or function. This script asks CourtListener's RECAP
// archive (free, no account) for filings matching a fixed set of query shapes, downloads the
// documents it holds, extracts their text with pdftotext, and records every repository
// citation with its GRANULARITY (repo / directory / document / file / function / line), the
// nearest patent and claim number, and the document's non-repository domains (a chart built
// on kubernetes.io is a documentation chart, and is kept, marked as such). A second pass reads
// the code a filing quotes BY NAME with no link at all (a call written as code, a source-file
// name) and places each name under the chart row it sits in, so a chart that pastes a Spark
// line or says "function secp256k1_ecdsa_sign_inner() is called from file main_impl.h" is
// caught too, with its row label as the pointer to the limitation.
//
//   node scripts/recap-claim-chart-search.mjs --out <dir outside the repo> [--shapes a,b] [--max-dockets N]
//       [--max-pages N] [--no-download] [--all-suits] [--delay-ms N]
//   node scripts/recap-claim-chart-search.mjs --out <dir> --rescore            # the text passes again, no network
//   node scripts/recap-claim-chart-search.mjs --out <dir> --render docs/real-world-claim-charts.md
//   node scripts/recap-claim-chart-search.mjs --out <dir> --cites <file.md>    # the code each document quotes, by chart row
//
// Resumable: a document already in <out>/catalog.jsonl is not fetched again. Downloaded PDFs are
// untrusted input: they live under <out>/pdf and nothing is ever executed from there. The search
// is polite (one request a second by default, backoff on 429/503). A miss is not absence: RECAP
// holds what its users uploaded, so gaps go to PACER afterwards, by hand.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const API = 'https://www.courtlistener.com/api/rest/v4/search/';
export const STORAGE = 'https://storage.courtlistener.com/';
export const USER_AGENT = 'CodeExam recap-claim-chart-search (github.com/aschulman42-cell/code-exam)';

/** The query shapes, each a different place a code citation hides. `type` r = filings, o = opinions. */
export const QUERY_SHAPES = [
  { key: 'chart-github', type: 'r', q: '"claim chart" github.com', why: 'a chart that names a repository' },
  { key: 'blob-infringement', type: 'r', q: 'github.com blob patent infringement', why: 'a file-level GitHub link anywhere in a patent filing' },
  { key: 'contentions-blob', type: 'r', q: '"infringement contentions" github.com blob', why: 'the contentions fight, where code citations are argued over' },
  { key: 'source-chart', type: 'r', q: '"source code" "claim chart" github.com', why: 'charts that say they rest on source code' },
  { key: 'strike-contentions', type: 'r', q: '"motion to strike" contentions github.com', why: 'motions to strike quote the contentions they attack' },
  { key: 'declaration-blob', type: 'r', q: 'declaration github.com blob patent', why: 'expert declarations, redacted versions filed' },
  { key: 'opinions-blob', type: 'o', q: 'github.com blob patent infringement', why: 'opinions that quote code (recorded by link only; 0 hits on 2026-10-20 in either ordering, kept for a later archive)' },
];

const REPO_URL = /https?:\/\/(?:www\.)?(github\.com|gitlab\.com|raw\.githubusercontent\.com)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:-\/)?(blob|tree|blame|raw)\/([^/\s)\]"'>]+)\/([^\s)\]"'>]+?))?(#[\w.:-]+)?(?=[\s)\]"'>,;]|$)/g;
const RAW_URL = /https?:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([^/\s)\]"'>]+)\/([^\s)\]"'>]+?)(?=[\s)\]"'>,;]|$)/g;
const SOURCE_EXT = /\.(?:c|cc|cpp|cxx|h|hpp|hh|java|kt|kts|scala|go|rs|py|pyx|rb|php|js|jsx|ts|tsx|mjs|cjs|swift|m|mm|cs|fs|sol|vy|sql|proto|sh|bash|ps1|lua|dart|ex|exs|erl|clj|hs|ml|r|jl|cu|glsl|asm|s|yaml|yml|toml|json|xml|gradle|cmake|mk)$/i;
const DOC_EXT = /\.(?:md|markdown|rst|txt|mediawiki|wiki|adoc|html?|pdf|ipynb)$/i;
export const GRANULARITY_RANK = { line: 6, function: 5, file: 4, document: 3, directory: 2, repo: 1, none: 0 };

const trimPath = (p) => String(p || '').replace(/[.,;:'")\]]+$/, '');

/** One repository link parsed: host, org, repo, kind (blob/tree/blame/raw), ref, path, fragment, granularity. Null for a non-repository URL. */
export function parseRepoUrl(url) {
  const s = String(url || '').trim();
  REPO_URL.lastIndex = 0; RAW_URL.lastIndex = 0;
  let m = REPO_URL.exec(s);
  let out = null;
  if (m && m.index === 0) {
    const [, host, org, repo, kind, ref, p, fragment] = m;
    // A bare repository link ending a sentence keeps its period in the match ("…/Duplex-Sequencing.").
    out = { host, org, repo: repo.replace(/\.+$/, ''), kind: kind || null, ref: ref || null, path: p ? trimPath(p) : null, fragment: fragment || null };
  } else {
    const r = RAW_URL.exec(s);
    if (!r || r.index !== 0) return null;
    const [, org, repo, ref, p] = r;
    out = { host: 'raw.githubusercontent.com', org, repo, kind: 'raw', ref, path: trimPath(p), fragment: null };
  }
  out.granularity = granularityOf(out);
  return out;
}

// A file is a basename with a name before its extension: a path of ".m" is what a URL wrapped
// across PDF lines leaves behind, and it is a directory-level hit at best, not a file.
const FILE_BASENAME = /(?:^|\/)[\w.-]*[\w-]\.[A-Za-z0-9]{1,8}$/;

export function granularityOf(link) {
  if (!link) return 'none';
  if (link.fragment && /^#L\d+/i.test(link.fragment)) return 'line';
  if (link.path) {
    if (DOC_EXT.test(link.path)) return 'document';
    if (FILE_BASENAME.test(link.path) && (SOURCE_EXT.test(link.path) || /\.[A-Za-z0-9]{1,8}$/.test(link.path))) return link.kind === 'tree' ? 'directory' : 'file';
    return 'directory';
  }
  return 'repo';
}

const FUNCTION_NEAR = [
  /\bfunction\s+["“'`]?([A-Za-z_$][\w$]*)["”'`]?/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /\bmethod\s+["“'`]?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)["”'`]?/,
  /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*\)/,
];

// "the function to transfer" names no function; prose words after "function" / "method" are not identifiers.
const NOT_A_NAME = new Set(['to', 'of', 'that', 'which', 'is', 'in', 'for', 'and', 'the', 'a', 'an', 'as', 'by', 'on', 'at', 'or', 'with', 'from',
  'it', 'this', 'be', 'are', 'was', 'were', 'can', 'will', 'may', 'not', 'if', 'then', 'than', 'into', 'each', 'when', 'where', 'calls', 'called',
  'call', 'returns', 'return', 'used', 'use', 'using', 'named', 'name', 'within', 'above', 'below', 'described', 'disclosed', 'performs', 'performed']);

/** The function a passage names near a link: looked for after the link first, then before. */
export function functionNear(text, index, length, window = 240) {
  const after = text.slice(index + length, index + length + window);
  const before = text.slice(Math.max(0, index - window), index);
  for (const seg of [after, before]) {
    for (const re of FUNCTION_NEAR) {
      const m = re.exec(seg);
      if (m && !NOT_A_NAME.has(m[1].toLowerCase()) && !/^(?:e\.g|i\.e|etc)$/i.test(m[1])) return m[1];
    }
  }
  return null;
}

const nearest = (text, index, re, window) => {
  const start = Math.max(0, index - window);
  const seg = text.slice(start, index + window);
  let best = null;
  for (const m of seg.matchAll(re)) {
    const d = Math.abs(start + m.index - index);
    if (!best || d < best.d) best = { d, value: m.slice(1).find(Boolean) };
  }
  return best ? best.value : null;
};

/**
 * The nearest patent mention around a position, whichever form it takes: "U.S. Patent No.
 * 9,948,712", "the 9,948,712 patent", or the '712 shorthand. Nearest wins over fullest: a
 * declaration cites a reference patent in full and the asserted patent as the '809 patent, and
 * the one beside the code citation is the one meant. A comma number alone is not a patent (a
 * filing is full of dollar figures and line counts); it counts only beside the word.
 */
const PATENT_FULL = [
  String.raw`\b(?:Pat(?:ent)?\.?\s+No\.?|U\.S\.\s*P(?:at)?\.?\s*(?:No\.?)?)\s*(\d{1,2},\d{3},\d{3})\b`,
  String.raw`\b(\d{1,2},\d{3},\d{3})\s+(?:[Pp]atent|B[12]\b)`,
  String.raw`(?:[Pp]atent|[Pp]atents)\s+(?:No\.?\s*)?(\d{1,2},\d{3},\d{3})\b`,
];
const PATENT_SHORT = String.raw`('\d{3})\s+[Pp]atent`;
export function patentNear(text, index, window = 2500) {
  const hit = nearest(text, index, new RegExp([...PATENT_FULL, PATENT_SHORT].join('|'), 'g'), window);
  if (!hit || !hit.startsWith("'")) return hit;
  // A shorthand and a full number ending in the same three digits are one patent: say it in full.
  const seg = text.slice(Math.max(0, index - window), index + window);
  const full = new RegExp(String.raw`\b(\d{1,2},\d{3},${hit.slice(1)})\b`).exec(seg);
  return full ? full[1] : hit;
}
export function claimNear(text, index, window = 800) {
  return nearest(text, index, /\b[Cc]laim\s+(\d{1,3})\b/g, window);
}

/**
 * Every full patent number a document cites beside the word, by count; a shorthand ('610 patent)
 * counts toward the full number it ends. The document's patents, for when no mention is near a
 * position: a pasted source listing sits pages from the nearest "Patent No."
 */
export function patentsIn(text, top = 3) {
  const s = String(text || '');
  const counts = new Map();
  for (const m of s.matchAll(new RegExp(PATENT_FULL.join('|'), 'g'))) { const v = m.slice(1).find(Boolean); counts.set(v, (counts.get(v) || 0) + 1); }
  for (const m of s.matchAll(new RegExp(PATENT_SHORT, 'g'))) { const full = [...counts.keys()].find((k) => k.endsWith(m[1].slice(1))); if (full) counts.set(full, counts.get(full) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([number, n]) => ({ number, n }));
}
/** The nearest mention when there is one (a shorthand resolved against the document's patents), else the document's most-cited patent. */
const resolvePatent = (near, patents) => {
  if (near) { const full = near.startsWith("'") ? patents.find((p) => p.number.endsWith(near.slice(1))) : null; return full ? full.number : near; }
  return patents[0] ? patents[0].number : null;
};

/** Flattens the extracted text so windows and URLs survive page breaks and hyphenated wraps. */
export function flatten(text) {
  return String(text || '').replace(/\r/g, '').replace(/-\n[ \t]*(?=[a-z])/g, '-').replace(/\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ');
}

/** Every repository citation in a document's text, with granularity, nearby function, patent and claim. */
export function citationsOf(rawText) {
  const text = flatten(rawText);
  const out = [];
  const seen = new Set();
  for (const re of [REPO_URL, RAW_URL]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const link = parseRepoUrl(m[0]);
      if (!link) continue;
      const fn = (link.granularity === 'file' || link.granularity === 'line') ? functionNear(text, m.index, m[0].length) : null;
      const c = {
        url: trimPath(m[0]), ...link,
        granularity: fn && link.granularity === 'file' ? 'function' : link.granularity,
        function: fn, patent: patentNear(text, m.index), claim: claimNear(text, m.index), at: m.index,
      };
      const key = `${c.url}|${c.function || ''}|${c.claim || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Non-repository domains a document cites, by count: documentation charts show up here. */
export function docDomains(rawText, top = 6) {
  const text = flatten(rawText);
  const counts = new Map();
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?=[/\s)\]"'>,;]|$)/gi)) {
    const d = m[1].toLowerCase();
    if (/^(github\.com|gitlab\.com|raw\.githubusercontent\.com)$/.test(d)) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([domain, n]) => ({ domain, n }));
}

// ---- code quoted by name, with no link --------------------------------------------------------
// A filing can quote code with no repository link at all: "function
// secp256k1_ecdsa_recoverable_signature_save() is called from file main_impl.h", a Spark line
// pasted into a summary-judgment exhibit, a C comment that ends in VerifyProfile(). The link pass
// never sees those; a grep of the first run's texts for empty parentheses did (2026-10-20). This
// pass reads them: a call whose name is shaped like code, and a source-file name outside any URL.
const CODE_CALL = /(?<![\w:>-])([A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::|->)[A-Za-z_][A-Za-z0-9_]*)*)\(([^()]{0,120}(?:\([^()]{0,80}\)[^()]{0,120})?)\)/g;
// No ".m": a wrapped "javax.management" leaves "javax.m", and Objective-C is rare in a filing.
const CODE_EXT = '(?:c|cc|cpp|cxx|h|hpp|hh|java|kt|kts|scala|go|rs|py|pyx|rb|php|js|jsx|ts|tsx|mjs|cjs|swift|mm|cs|fs|sol|vy|proto|lua|dart|ex|exs|erl|clj|hs|ml|jl|cu|glsl|asm)';
// A stem of three or more characters starting with a letter, at most one dotted segment, not a
// web host: "p.m", "1.c", "IX.1.c" and "C.cc" are prose and section numbers, "org.omg.stub.java"
// is a package name, "www.bittware.c" a wrapped ".com"; "main_impl.h", "jquery.min.js" and
// "SortMergeJoinExec.scala" are files. A dotted stem is a JavaScript habit ("x.min.js",
// "x.test.ts"); under any other extension it is a package name ("com.gau.go", "com.tencent.mm").
const CODE_FILE = new RegExp(String.raw`(?<![\w/.-])(?!www\.)([A-Za-z_][\w-]{2,}(?:\.[A-Za-z_][\w-]+)?\.${CODE_EXT})(?![\w/-])`, 'g');
const fileShaped = (name) => { const dot = name.lastIndexOf('.'); return !name.slice(0, dot).includes('.') || /^(?:js|jsx|ts|tsx|mjs|cjs)$/i.test(name.slice(dot + 1)); };
// Patent(s), claim(s), RaDaR(R), GelScann(1.0): parentheses prose and product names use.
const NOT_CALL_ARGS = /^\s*(?:R|TM|SM|s|es|\d+\.\d+)\s*$/;

/** Is "name(args)" a call written as code? A code-shaped name (underscore, dotted path, inner capital), or any plain word followed by empty parentheses. */
export function codeShapedCall(name, args = '') {
  if (NOT_CALL_ARGS.test(args)) return false;
  const letters = name.replace(/[^A-Za-z]/g, '').length;
  if (letters < 2 || /_$/.test(name)) return false; // "A9(" on a garbled page, "_(", "Satoshi_(unit)"
  if (/[_.]|::|->|[a-z][A-Z]/.test(name)) return true;
  return /^\s*$/.test(args) && letters >= 3 && !NOT_A_NAME.has(name.toLowerCase()); // mint(), wait( )
}

// ---- chart rows, claim pages and complaint paragraphs ----------------------------------------
// Three shapes of document name code (measured on the 2026-10-20 run, docs/real-world-claim-charts.md):
// a claim chart, two columns with a row label (the claim column left, the evidence right), sometimes
// opened by a claim-text page (the label left, the limitation right); a narrative complaint,
// numbered paragraphs and no labels; a listing or report. pdftotext -layout keeps a page's columns
// at a stable character offset, so the claim column is the slice left of the page's dominant gap,
// and no coordinates are needed (the bundled pdftotext is Xpdf, which has none).

const PAGE_HEADER = /\bCase\s+\d+:\d{2}-[a-z]{2}-\d+.*\bDocument\s+\d+.*\bPage\s+\d+\s+of\s+\d+/i;
const LABEL_FORMS = [
  { re: /^(\d{1,3})[ \t]?[\[(](pre|p|[a-z]{1,2}|[ivx]{1,4})[\])](?:[ \t]?\(([ivx]{1,4}|\d)\))?/, kind: 'element' }, // 1[a] 1(b) 1[pre] 1(a)(i)
  { re: /^\[(\d{1,3})\.?(pre|[a-z])\]/, kind: 'element' },                                                        // [1a] [1.a]
  { re: /^(?:Limitation|Element|Step)[ \t]+(\d{1,3})(?:[ \t]?[\[(]([a-z]{1,2}|pre)[\])]|\.(\d{1,2}))?(?!\w)/i, kind: 'element', words: true }, // Element 1, Limitation 1[a], Element 1.2
  { re: /^(\d{1,3})\.(\d{1,2})(?=[ \t]+(?:[a-z(]|A\b))/, kind: 'element', dotted: true },                        // 1.1 wherein (a paragraph is "17. The")
  { re: /^\[([a-z])\]/, kind: 'element', bare: true },                                                            // [a], its claim from context
  { re: /^(?:Claim|CLAIM)[ \t]+(\d{1,3})(?![\w\[(.])/, kind: 'claim' },                                           // Claim 16: a header, or a one-row-per-claim chart
];

/** A chart row label at the start of a slice of text, as {kind, claim, element, label, len}, or null. A bare [a] or "Element 1" takes its claim from context. */
export function parseLabel(s, claimContext = null) {
  const raw = String(s || ''), t = raw.trimStart();
  for (const f of LABEL_FORMS) {
    const m = f.re.exec(t);
    if (!m) continue;
    let claim, element;
    if (f.kind === 'claim') { claim = m[1]; element = null; }
    else if (f.bare) { claim = claimContext; element = m[1]; }
    else if (f.words) { if (m[2] || m[3]) { claim = m[1]; element = m[2] || m[3]; } else { claim = claimContext; element = m[1]; } }
    else { claim = m[1]; element = m[2] + (m[3] && !f.dotted ? `(${m[3]})` : ''); }
    if (!claim) return null;
    const label = f.kind === 'claim' ? `claim ${claim}` : (f.dotted ? `${claim}.${element}` : `${claim}[${element}]`);
    return { kind: f.kind, claim, element, label, len: raw.length - t.length + m[0].length };
  }
  return null;
}

const EVIDENCE = /\b(?:See|For example|Exhibit|Ex\.|Accused|Source:|Infringement|evidence|Defendant|Plaintiff)\b|\bwww\./;
const CLAIMISH = /\b(?:wherein|comprising|comprises|configured to|a method|the method|a system|the system|the step|said|at least one|apparatus|medium|plurality|each|thereof|respective|associated with|based on|corresponding|coupled|operable)\b/i;
const CHART_WORDS = /\b(?:Exemplary Evidence|Claim Chart|Infringement Chart|Accused Instrumentalit)/i;
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * The column where a page's right column starts: the first column with a blank channel two
 * characters wide on at least 92% of the page's lines, text to its left on at least a fifth of
 * them and text at or beyond it on at least half; null for a one-column page. (The mode of
 * right-text start offsets was tried first and landed on code indentation inside the evidence
 * column of R2 v. Databricks, leaking evidence into the limitation.)
 */
export function columnBoundary(lines) {
  const rows = lines.filter((l) => l.trim() && !PAGE_HEADER.test(l));
  const n = rows.length;
  if (n < 3) return null;
  const maxLen = Math.max(...rows.map((l) => l.length));
  const ws = (l, c) => c >= l.length || l[c] === ' ' || l[c] === '\t';
  for (let c = 6; c < Math.min(maxLen, 120); c++) {
    let channel = 0, leftText = 0, rightText = 0;
    for (const l of rows) {
      if (ws(l, c - 1) && ws(l, c - 2)) channel++;
      if (/\S/.test(l.slice(0, c - 2))) leftText++;
      if (/\S/.test(l.slice(c))) rightText++;
    }
    if (channel >= n * 0.92 && leftText >= n * 0.2 && rightText >= n * 0.5) return c;
  }
  return null;
}
// A footnote or source line spanning the page width sits in the claim column's slice without being claim text.
const SPILL = /\b(?:Source:|See\b|For example|Exhibit\b|EXHIBIT\b|All website|Claim Chart\b|Claim Feature\b|Claim No\.|Exemplary Evidence)/;

/**
 * Walks a document page by page. A row opens at a label at the start of the claim column and runs
 * to the next label, across page breaks; a "Claim N" line is a row of its own only when no element
 * row is open (above a continuing element row it is a page header). Each mention lands in the row
 * whose lines hold it, every occurrence. A row's limitation is its claim-column text; failing that,
 * the text a claim-text page gave its label; failing that, the head of its evidence text.
 */
export function chartRows(text, mentions = []) {
  const pages = String(text || '').split('\f');
  const rows = new Map(), order = [], spans = [];
  let cur = null, span = null, claimContext = null, pagesWithColumns = 0, off = 0;
  const open = (lab, at) => {
    let row = rows.get(lab.label);
    if (!row) { row = { label: lab.label, kind: lab.kind, claim: lab.claim, element: lab.element, at, functions: [], files: [], spans: [] }; rows.set(lab.label, row); order.push(row); }
    cur = row; span = { start: at, end: at, row, left: '', right: '', hasMentions: false }; spans.push(span); row.spans.push(span);
  };
  for (const page of pages) {
    const lines = page.split('\n');
    const B = columnBoundary(lines);
    if (B != null) pagesWithColumns++;
    let at = off;
    for (const line of lines) {
      const len = line.length + 1;
      // A one-column page has no claim column: its text is evidence, and the limitation comes from a claim page or the head.
      const left = B != null ? line.slice(0, B) : line, right = B != null ? line.slice(B) : '';
      const lab = PAGE_HEADER.test(line) ? null : parseLabel(left, claimContext);
      if (PAGE_HEADER.test(line) || (lab && lab.kind === 'claim' && cur && cur.kind !== 'claim')) { if (lab) claimContext = lab.claim; at += len; continue; }
      if (lab) { claimContext = lab.claim; open(lab, at); }
      if (span) {
        const rest = lab ? left.slice(lab.len) : left;
        if (B != null && !SPILL.test(rest)) { span.left += `${rest}\n`; span.right += `${right}\n`; } else span.right += `${rest}${right}\n`;
        span.end = at + len;
      }
      at += len;
    }
    off += page.length + 1;
  }
  for (const m of mentions) {
    const s = spans.find((x) => m.at >= x.start && m.at < x.end);
    if (!s) continue;
    const list = s.row[m.kind === 'file' ? 'files' : 'functions'];
    if (!list.includes(m.name)) list.push(m.name);
    m.row = s.row.label; s.hasMentions = true;
  }
  const limitations = {};
  for (const r of order) {
    let left = '', claimPage = null, head = null;
    for (const s of r.spans) {
      const l = collapse(s.left), rt = collapse(s.right);
      if (l.length > left.length) left = l;
      if (!claimPage && l.length < 20 && rt && !s.hasMentions && CLAIMISH.test(rt) && !EVIDENCE.test(rt)) claimPage = rt;
      if (!head && rt) head = rt;
    }
    if (claimPage) limitations[r.label] = claimPage.slice(0, 600);
    if (left.length >= 20) { r.limitation = left.slice(0, 600); r.source = 'left'; if (!limitations[r.label]) limitations[r.label] = r.limitation; }
    else if (claimPage) { r.limitation = claimPage.slice(0, 600); r.source = 'claim-page'; }
    else { r.limitation = (head || '').slice(0, 160); r.source = 'head'; }
    delete r.spans;
  }
  const elementRows = order.filter((r) => r.kind === 'element').length;
  return { rows: order, limitations, pages: pages.length, pagesWithColumns, elementRows, claimRows: order.length - elementRows };
}

const PARA_START = /^[ \t]{0,12}(\d{1,3})\.[ \t]+(?=[A-Z"“(])/;
/** The numbered paragraphs of a pleading or declaration, in order, as {n, start, end, body}; the numbering must rise, so a list inside a paragraph does not split it. */
export function paragraphsOf(text) {
  const out = [];
  let cur = null, at = 0, prev = 0;
  for (const line of String(text || '').split('\n')) {
    const len = line.length + 1;
    const m = PARA_START.exec(line);
    const n = m ? Number(m[1]) : 0;
    // The first paragraph may carry any number (an excerpt, an exhibit); after that the numbering rises by at most 50.
    if (m && n > prev && (prev === 0 || n <= prev + 50)) { if (cur) cur.end = at; cur = { n, start: at, end: at + len, body: '' }; out.push(cur); prev = n; }
    if (cur && !PAGE_HEADER.test(line)) { cur.body += `${line}\n`; cur.end = at + len; }
    at += len;
  }
  return out;
}
const claimOfParagraph = (text, p) => {
  const inBody = /\b[Cc]laims?\s+(\d{1,3})\b/.exec(p.body);
  if (inBody) return inBody[1];
  const back = [...text.slice(Math.max(0, p.start - 3000), p.start).matchAll(/\b[Cc]laims?\s+(\d{1,3})\b/g)];
  return back.length ? back[back.length - 1][1] : null;
};
const quoteOf = (body) => {
  for (const m of body.matchAll(/["“]([^"”]{30,300})["”]/g)) if (m[1].trim().split(/\s+/).length >= 6) return collapse(m[1]);
  const p = /\b(?:the step of|configured to|comprising|wherein)\b[^.;]{10,200}/i.exec(body);
  return p ? collapse(p[0]) : null;
};

/** The document's shape from what the walk found: chart, narrative, listing or other. */
export function layoutOf({ elementRows = 0, claimRows = 0, pagesWithColumns = 0, pages = 1, paragraphs = 0, functionCount = 0, chartWords = false } = {}) {
  if (elementRows >= 2 || (claimRows >= 1 && (chartWords || pagesWithColumns >= Math.max(1, pages * 0.3)))) return 'chart';
  if (paragraphs >= 10) return 'narrative';
  if (functionCount >= 20) return 'listing';
  return 'other';
}

/** A document "quotes code by name" when its text mentions at least this many distinct functions written as code. */
export const CODE_QUOTED_MIN = 3;

/**
 * Functions and source files a document names as code, link or no link, with counts; every
 * occurrence placed under the chart row it sits in, else the numbered paragraph; the limitations a
 * claim-text page or the claim column gave each label; the document's layout; the nearest patent to
 * the lead mention with the document's most-cited one as the fallback; the claim from the lead's
 * row or paragraph, else the nearest claim mention. Runs on the raw text with URLs blanked to
 * spaces of the same length, so the columns keep their offsets.
 */
export function codeMentions(rawText, { top = 12, perRow = 24, maxRows = 40, maxParagraphs = 40 } = {}) {
  const text = String(rawText || '').replace(/\r/g, '').replace(/https?:\/\/\S+/g, (u) => ' '.repeat(u.length));
  const mentions = [];
  for (const m of text.matchAll(CODE_CALL)) if (codeShapedCall(m[1], m[2])) mentions.push({ name: m[1], kind: 'function', at: m.index });
  for (const m of text.matchAll(CODE_FILE)) if (fileShaped(m[1])) mentions.push({ name: m[1], kind: 'file', at: m.index });
  const chart = chartRows(text, mentions);
  const paras = paragraphsOf(text);
  const byPara = new Map();
  for (const m of mentions) {
    if (m.row) continue;
    const p = paras.find((x) => m.at >= x.start && m.at < x.end);
    if (!p) continue;
    let pr = byPara.get(p.n);
    if (!pr) { pr = { n: p.n, at: p.start, claim: claimOfParagraph(text, p), quote: quoteOf(p.body), functions: [], files: [] }; byPara.set(p.n, pr); }
    const list = pr[m.kind === 'file' ? 'files' : 'functions'];
    if (!list.includes(m.name)) list.push(m.name);
    m.paragraph = p.n;
  }
  const fns = new Map(), files = new Map();
  for (const m of mentions) {
    const map = m.kind === 'file' ? files : fns;
    const e = map.get(m.name) || { name: m.name, n: 0, at: m.at, label: m.row || (m.paragraph ? `¶ ${m.paragraph}` : null) };
    e.n++; map.set(m.name, e);
  }
  const rank = (a, b) => (b.n - a.n) || (a.at - b.at);
  const functions = [...fns.values()].sort(rank), sources = [...files.values()].sort(rank);
  const lead = functions[0] || sources[0] || null;
  const strip = ({ at, ...e }) => e;
  const patents = patentsIn(text);
  const rows = chart.rows.filter((r) => r.functions.length || r.files.length).slice(0, maxRows)
    .map((r) => ({ label: r.label, claim: r.claim, element: r.element, limitation: r.limitation, source: r.source, functions: r.functions.slice(0, perRow), files: r.files.slice(0, perRow) }));
  const paragraphs = [...byPara.values()].sort((a, b) => a.at - b.at).slice(0, maxParagraphs)
    .map(({ at, ...p }) => ({ ...p, functions: p.functions.slice(0, perRow), files: p.files.slice(0, perRow) }));
  const leadRow = lead && lead.label ? (rows.find((r) => r.label === lead.label) || paragraphs.find((p) => `¶ ${p.n}` === lead.label) || null) : null;
  const layout = layoutOf({ ...chart, paragraphs: paras.length, functionCount: fns.size, chartWords: CHART_WORDS.test(text) });
  return {
    layout, functionCount: fns.size, fileCount: files.size,
    functions: functions.slice(0, top).map(strip), files: sources.slice(0, top).map(strip),
    rows, paragraphs, limitations: Object.fromEntries(Object.entries(chart.limitations).slice(0, 40)),
    patents, patent: resolvePatent(lead ? patentNear(text, lead.at) : null, patents),
    claim: leadRow && leadRow.claim ? leadRow.claim : (lead ? claimNear(text, lead.at) : null),
  };
}

/** The document-level summary: its best granularity, distinct repositories, citations, domains, and the code it quotes by name. */
export function summarizeText(rawText) {
  const citations = citationsOf(rawText);
  const best = citations.reduce((b, c) => (GRANULARITY_RANK[c.granularity] > GRANULARITY_RANK[b] ? c.granularity : b), 'none');
  const repos = [...new Set(citations.map((c) => `${c.org}/${c.repo}`))];
  return { best, repos, citations, domains: docDomains(rawText), chars: String(rawText || '').length, code: codeMentions(rawText) };
}

// ---- network -------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { fetchImpl = fetch, retries = 3 } = {}) {
  for (let i = 0; ; i++) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (res.ok) return res.json();
    // 429 is the rate limit; 502/503/504 are the archive's own bad minutes (a 502 ended the first run).
    if ([429, 502, 503, 504].includes(res.status) && i < retries) { await sleep(res.status === 429 ? 30000 * (i + 1) : 10000 * (i + 1)); continue; }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

/** Walks one query shape's result pages (cursor paging), yielding each docket (type r) or opinion cluster (type o). */
export async function* searchShape(shape, { maxPages = 10, delayMs = 1200, fetchImpl = fetch, log = () => {} } = {}) {
  let url = `${API}?type=${shape.type}&q=${encodeURIComponent(shape.q)}&order_by=${encodeURIComponent('dateFiled desc')}`;
  for (let page = 1; url && page <= maxPages; page++) {
    const body = await getJson(url, { fetchImpl });
    log(`${shape.key}: page ${page}, ${body.count} hits in all`);
    for (const r of body.results || []) yield r;
    url = body.next || null;
    if (url) await sleep(delayMs);
  }
}

export async function downloadPdf(doc, outDir, { fetchImpl = fetch } = {}) {
  const file = path.join(outDir, 'pdf', `${doc.id}.pdf`);
  if (fs.existsSync(file)) return file;
  if (!doc.is_available || !doc.filepath_local) return null;
  const res = await fetchImpl(STORAGE + doc.filepath_local, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${doc.filepath_local}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** pdftotext -layout; the binary Git for Windows bundles, or poppler. A missing binary is an error, not a silent skip. */
export function extractText(pdfFile, outDir) {
  const txt = path.join(outDir, 'txt', `${path.basename(pdfFile, '.pdf')}.txt`);
  if (fs.existsSync(txt)) return fs.readFileSync(txt, 'utf8');
  fs.mkdirSync(path.dirname(txt), { recursive: true });
  const r = spawnSync('pdftotext', ['-layout', pdfFile, txt], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('pdftotext not found. Git for Windows bundles it (C:\\Program Files\\Git\\mingw64\\bin); elsewhere install poppler-utils.');
  }
  if (r.status !== 0) throw new Error(`pdftotext failed on ${pdfFile}: ${(r.stderr || '').trim().slice(0, 200)}`);
  return fs.readFileSync(txt, 'utf8');
}

// ---- catalog --------------------------------------------------------------------------------

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const docketRow = (r) => ({
  caseName: r.caseName, court: r.court, courtId: r.court_id, docketNumber: r.docketNumber, docketId: r.docket_id,
  dateFiled: r.dateFiled, suitNature: r.suitNature || null, docketUrl: r.docket_absolute_url ? `https://www.courtlistener.com${r.docket_absolute_url}` : null,
});

/** One catalog row per document: the docket, the document, the download URL and the text summary. */
export function catalogRow(docket, doc, summary, shapeKey) {
  return {
    ...docketRow(docket),
    docId: doc.id, documentNumber: doc.document_number, attachmentNumber: doc.attachment_number ?? null,
    description: (doc.description || doc.short_description || '').slice(0, 200), pages: doc.page_count ?? null,
    entryDate: doc.entry_date_filed || null, available: !!doc.is_available,
    pdfUrl: doc.filepath_local ? STORAGE + doc.filepath_local : null,
    pageUrl: doc.absolute_url ? `https://www.courtlistener.com${doc.absolute_url}` : null,
    shapes: [shapeKey],
    ...(summary ? { best: summary.best, repos: summary.repos, chars: summary.chars, domains: summary.domains,
      citations: summary.citations.map(({ at, ...c }) => c), code: summary.code } : { best: null, repos: [], chars: 0, domains: [], citations: [], code: null }),
  };
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const quotesCode = (r) => !!(r.code && r.code.functionCount >= CODE_QUOTED_MIN);
const docLabel = (r) => `${r.documentNumber ?? ''}${r.attachmentNumber ? `-${r.attachmentNumber}` : ''}`;
const names = (list, n = 3) => (list || []).slice(0, n).map((e) => `\`${short(e.name, 48)}\``).join(', ');

/** The Markdown the docs page carries between its catalog markers: a granularity distribution, then the rows, finest first. */
export function renderCatalog(rows, { limit = 60, generatedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const dist = new Map();
  for (const r of rows) dist.set(r.best || 'none', (dist.get(r.best || 'none') || 0) + 1);
  const order = Object.keys(GRANULARITY_RANK).sort((a, b) => GRANULARITY_RANK[b] - GRANULARITY_RANK[a]);
  const out = [];
  out.push(`_Generated ${generatedAt} by \`scripts/recap-claim-chart-search.mjs --render\` from ${rows.length} document(s); edit the script, not this block._`, '');
  out.push('| best citation in the document | documents |', '|---|---:|');
  for (const g of order) if (dist.has(g)) out.push(`| ${g} | ${dist.get(g)} |`);
  const fine = (r) => GRANULARITY_RANK[r.best || 'none'] >= GRANULARITY_RANK.file;
  const quoting = rows.filter(quotesCode), quotingCoarse = quoting.filter((r) => !fine(r));
  out.push('', `**Code quoted by name** (at least ${CODE_QUOTED_MIN} distinct functions written as code, link or no link): ${quoting.length} document(s), ${quotingCoarse.length} without a file-level link.`, '');
  const ranked = rows.filter(fine)
    .sort((a, b) => (GRANULARITY_RANK[b.best] - GRANULARITY_RANK[a.best]) || String(b.dateFiled || '').localeCompare(String(a.dateFiled || '')));
  out.push(`**File-level or finer (${ranked.length})**`, '');
  out.push('| case | court | docket | document | filed | best | repository | function | patent | claim | code | PDF |', '|---|---|---|---|---|---|---|---|---|---|---:|---|');
  for (const r of ranked.slice(0, limit)) {
    const c = (r.citations || []).slice().sort((x, y) => GRANULARITY_RANK[y.granularity] - GRANULARITY_RANK[x.granularity])[0] || {};
    const doc = `${r.documentNumber ?? ''}${r.attachmentNumber ? `-${r.attachmentNumber}` : ''}`;
    out.push(`| ${esc(short(r.caseName, 48))} | ${esc(r.courtId)} | ${esc(r.docketNumber)} | ${esc(doc)} | ${esc(r.dateFiled)} | ${esc(r.best)} | ${esc(c.org ? `${c.org}/${c.repo}${c.path ? ` ${short(c.path, 64)}` : ''}` : '')} | ${esc(c.function || '')} | ${esc(c.patent || '')} | ${esc(c.claim || '')} | ${r.code ? r.code.functionCount : ''} | ${r.pdfUrl ? `[pdf](${r.pdfUrl})` : ''} |`);
  }
  if (ranked.length > limit) out.push('', `_${ranked.length - limit} more file-level row(s) in the JSONL._`);
  const byCount = (a, b) => (b.code.functionCount - a.code.functionCount) || String(b.dateFiled || '').localeCompare(String(a.dateFiled || ''));
  out.push('', `**Code quoted without a file link (${quotingCoarse.length})**: the link pass put these at repository, directory, document or no link, but the text names functions and source files as code (\`layout\`: chart, narrative, listing or other; \`code\` counts distinct functions; the first three names are shown).`);
  if (quotingCoarse.length) {
    out.push('', '| case | court | docket | document | filed | link | layout | code | functions | source files | patent | claim | PDF |', '|---|---|---|---|---|---|---|---:|---|---|---|---|---|');
    for (const r of quotingCoarse.slice().sort(byCount).slice(0, limit)) {
      out.push(`| ${esc(short(r.caseName, 48))} | ${esc(r.courtId)} | ${esc(r.docketNumber)} | ${esc(docLabel(r))} | ${esc(r.dateFiled)} | ${esc(r.best)} | ${esc(r.code.layout || '')} | ${r.code.functionCount} | ${esc(names(r.code.functions))} | ${esc(names(r.code.files))} | ${esc(r.code.patent || '')} | ${esc(r.code.claim || '')} | ${r.pdfUrl ? `[pdf](${r.pdfUrl})` : ''} |`);
    }
  }
  const coarse = rows.length - ranked.length;
  out.push('', `**Coarser (${coarse})**: repository, directory or documentation links only, or no repository link; their domains say what the chart rests on (documentation sites lead). They are in the JSONL with \`best\` set; the ones that quote code are the table above, the rest are not listed here.`);
  return out.join('\n');
}

/**
 * The reader's listing of the code each document quotes: case, patent, the repository link if
 * any, then each chart row's label and head with the functions and source files named under it.
 * Written with --cites; long, so it goes to a file of its own.
 */
export function renderCites(rows, { generatedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const docs = rows.filter((r) => r.code && (r.code.functionCount > 0 || r.code.fileCount > 0))
    .sort((a, b) => (b.code.functionCount - a.code.functionCount) || (b.code.fileCount - a.code.fileCount));
  const out = ['# Code cited by name in public patent filings', '',
    `_Generated ${generatedAt} by \`scripts/recap-claim-chart-search.mjs --cites\` from ${rows.length} document(s), ${docs.length} of which name a function or a source file as code. A party's chart is advocacy. The row label and head are read by rule from a two-column layout: a pointer into the PDF, not a quotation of the limitation._`, ''];
  const tick = (n) => `\`${n}\``;
  for (const r of docs) {
    const c = r.code;
    const link = (r.citations || []).slice().sort((x, y) => GRANULARITY_RANK[y.granularity] - GRANULARITY_RANK[x.granularity])[0];
    out.push(`## ${r.caseName}`, '', `${r.courtId} ${r.docketNumber}, document ${docLabel(r)}, filed ${r.dateFiled}${c.patent ? `, patent ${c.patent}` : ''}${c.claim ? `, claim ${c.claim}` : ''}${r.pdfUrl ? `, [pdf](${r.pdfUrl})` : ''}.`);
    if (link && link.org) out.push('', `Repository link (${link.granularity}): ${tick(`${link.org}/${link.repo}${link.path ? ` ${link.path}` : ''}`)}${link.function ? `, function ${tick(link.function)}` : ''}${link.patent ? `, patent ${link.patent}` : ''}${link.claim ? `, claim ${link.claim}` : ''}.`);
    if (c.patents && c.patents.length) out.push('', `Patents cited in the document: ${c.patents.map((p) => `${p.number} ×${p.n}`).join(', ')}.`);
    out.push('', `${c.functionCount} function(s) and ${c.fileCount} source file(s) named as code; layout: ${c.layout || 'other'}.`, '');
    const placed = new Set();
    const names = (unit) => {
      for (const n of unit.functions) placed.add(`f:${n}`);
      for (const n of unit.files) placed.add(`s:${n}`);
      if (unit.functions.length) out.push(`  - functions: ${unit.functions.map(tick).join(', ')}`);
      if (unit.files.length) out.push(`  - files: ${unit.files.map(tick).join(', ')}`);
    };
    for (const row of c.rows || []) {
      if (!row.functions.length && !row.files.length) continue;
      out.push(`- **${row.label}**${row.source ? ` [${row.source}]` : ''}${row.limitation ? ` "${esc(row.limitation)}"` : ''}`);
      names(row);
    }
    for (const p of c.paragraphs || []) {
      out.push(`- **¶ ${p.n}**${p.claim ? ` (claim ${p.claim})` : ''}${p.quote ? ` "${esc(p.quote)}"` : ''}`);
      names(p);
    }
    const rest = (list, k) => list.filter((e) => !placed.has(`${k}:${e.name}`)).map((e) => `${tick(e.name)}${e.n > 1 ? ` ×${e.n}` : ''}`);
    const restF = rest(c.functions, 'f'), restS = rest(c.files, 's');
    if (restF.length || restS.length) {
      out.push('- **no row or paragraph nearby**');
      if (restF.length) out.push(`  - functions: ${restF.join(', ')}`);
      if (restS.length) out.push(`  - files: ${restS.join(', ')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

export const CATALOG_START = '<!-- catalog:start -->';
export const CATALOG_END = '<!-- catalog:end -->';

/** Replaces the generated block of the docs page; the markers must both exist. */
export function replaceSection(docText, rendered) {
  const a = docText.indexOf(CATALOG_START), b = docText.indexOf(CATALOG_END);
  if (a < 0 || b < 0 || b < a) throw new Error(`catalog markers ${CATALOG_START} … ${CATALOG_END} not found`);
  return `${docText.slice(0, a + CATALOG_START.length)}\n${rendered}\n${docText.slice(b)}`;
}

// ---- main -----------------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { out: null, shapes: null, maxDockets: 50, maxPages: 10, download: true, allSuits: false, delayMs: 1200, render: null, rescore: false, cites: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--out') { o.out = v; i++; } else if (a === '--shapes') { o.shapes = v.split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (a === '--max-dockets') { o.maxDockets = Number(v); i++; } else if (a === '--max-pages') { o.maxPages = Number(v); i++; }
    else if (a === '--no-download') o.download = false; else if (a === '--all-suits') o.allSuits = true;
    else if (a === '--delay-ms') { o.delayMs = Number(v); i++; } else if (a === '--render') { o.render = v; i++; }
    else if (a === '--rescore') o.rescore = true; else if (a === '--cites') { o.cites = v; i++; }
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Re-runs the citation pass over the texts already extracted, for rows whose rules changed; no network. */
export function rescore(outDir) {
  const jsonl = path.join(outDir, 'catalog.jsonl');
  const rows = readJsonl(jsonl);
  let n = 0;
  for (const r of rows) {
    const txt = path.join(outDir, 'txt', `${r.docId}.txt`);
    if (!fs.existsSync(txt)) continue;
    const s = summarizeText(fs.readFileSync(txt, 'utf8'));
    Object.assign(r, { best: s.best, repos: s.repos, chars: s.chars, domains: s.domains, citations: s.citations.map(({ at, ...c }) => c), code: s.code });
    n++;
  }
  fs.writeFileSync(jsonl, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return { rows: rows.length, rescored: n };
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (!o.out) { console.error('usage: node scripts/recap-claim-chart-search.mjs --out <dir> [--shapes a,b] [--max-dockets N] [--max-pages N] [--no-download] [--all-suits] [--delay-ms N] [--rescore] [--render docs/real-world-claim-charts.md] [--cites <file.md>]'); process.exit(2); }
  const jsonl = path.join(o.out, 'catalog.jsonl');
  if (o.rescore) {
    const r = rescore(o.out);
    console.log(`rescored ${r.rescored} of ${r.rows} row(s) from the extracted texts in ${o.out}`);
    return;
  }
  if (o.cites) {
    const rows = readJsonl(jsonl);
    fs.writeFileSync(o.cites, renderCites(rows), 'utf8');
    console.log(`listed the code ${rows.filter((r) => r.code && (r.code.functionCount > 0 || r.code.fileCount > 0)).length} of ${rows.length} document(s) quote by name into ${o.cites}`);
    return;
  }
  if (o.render) {
    const rows = readJsonl(jsonl);
    const doc = fs.readFileSync(o.render, 'utf8');
    fs.writeFileSync(o.render, replaceSection(doc, renderCatalog(rows)), 'utf8');
    console.log(`rendered ${rows.length} row(s) into ${o.render}`);
    return;
  }
  fs.mkdirSync(o.out, { recursive: true });
  const shapes = QUERY_SHAPES.filter((s) => !o.shapes ? s.type === 'r' : o.shapes.includes(s.key));
  const rows = readJsonl(jsonl);
  const byDoc = new Map(rows.map((r) => [String(r.docId), r]));
  const dockets = readJsonl(path.join(o.out, 'dockets.jsonl'));
  const docketSeen = new Set(dockets.map((d) => `${d.shape}|${d.docketId ?? d.clusterId}`));
  const append = (file, obj) => fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
  const log = (m) => console.error(`# ${m}`);
  const stats = { dockets: 0, skippedSuit: 0, docs: 0, downloaded: 0, failed: 0, reused: 0, opinions: 0, shapesFailed: [] };
  for (const shape of shapes) {
    let n = 0;
    // One shape's bad page must not end the run: the rows so far are on disk, the next shape
    // still runs, and the summary names the shape to re-run (the run is resumable).
    try {
    for await (const r of searchShape(shape, { maxPages: o.maxPages, delayMs: o.delayMs, log })) {
      if (n++ >= o.maxDockets) break;
      if (shape.type === 'o') {
        const key = `${shape.key}|${r.cluster_id}`;
        if (docketSeen.has(key)) continue;
        docketSeen.add(key); stats.opinions++;
        append(path.join(o.out, 'dockets.jsonl'), { shape: shape.key, kind: 'opinion', clusterId: r.cluster_id, caseName: r.caseName, court: r.court, dateFiled: r.dateFiled, url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null, snippet: (r.opinions || []).map((x) => x.snippet).join(' ').slice(0, 400) });
        continue;
      }
      if (!o.allSuits && !/patent|830/i.test(r.suitNature || '')) { stats.skippedSuit++; continue; }
      const key = `${shape.key}|${r.docket_id}`;
      if (!docketSeen.has(key)) { docketSeen.add(key); stats.dockets++; append(path.join(o.out, 'dockets.jsonl'), { shape: shape.key, kind: 'docket', ...docketRow(r) }); }
      for (const doc of r.recap_documents || []) {
        const had = byDoc.get(String(doc.id));
        if (had) { if (!had.shapes.includes(shape.key)) had.shapes.push(shape.key); stats.reused++; continue; }
        stats.docs++;
        let summary = null;
        if (o.download) {
          try {
            const pdf = await downloadPdf(doc, o.out);
            if (pdf) { summary = summarizeText(extractText(pdf, o.out)); stats.downloaded++; await sleep(Math.min(o.delayMs, 600)); }
          } catch (e) { stats.failed++; log(`${doc.id}: ${e.message}`); }
        }
        const row = catalogRow(r, doc, summary, shape.key);
        byDoc.set(String(doc.id), row);
        append(jsonl, row);
        const quoted = summary ? quotesCode(summary) : false;
        if (summary && (summary.best !== 'none' || quoted)) log(`${shape.key}: ${short(r.caseName, 40)} doc ${doc.document_number}${doc.attachment_number ? `-${doc.attachment_number}` : ''}: ${summary.best} (${summary.repos.slice(0, 2).join(', ')})${quoted ? `; code by name ${summary.code.functionCount}` : ''}`);
      }
    }
    } catch (e) { stats.shapesFailed.push(shape.key); log(`${shape.key}: stopped after ${n} docket(s): ${e.message}`); }
  }
  // Rows gain shapes over a run; rewrite the JSONL once so the file reflects them.
  fs.writeFileSync(jsonl, [...byDoc.values()].map((r) => JSON.stringify(r)).join('\n') + (byDoc.size ? '\n' : ''), 'utf8');
  console.log(`dockets ${stats.dockets} (+${stats.skippedSuit} not patent suits), documents ${stats.docs} new / ${stats.reused} seen, downloaded ${stats.downloaded}, failed ${stats.failed}, opinions ${stats.opinions}; catalog ${jsonl} (${byDoc.size} rows)`
    + (stats.shapesFailed.length ? `; shapes stopped early, re-run them: ${stats.shapesFailed.join(', ')}` : ''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
