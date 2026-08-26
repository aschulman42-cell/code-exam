#!/usr/bin/env node
// litigated-claims-fetch.mjs -- claim 1 + its dependent chain for litigated
// US patents, fetched from patents.google.com (robots.txt allows /patent/).
//
// Inputs
//   --litigation <csv>   USPTO litigation CSV (case_number, case_name, date_filed, patent, ...)
//   --cpc-join <csv>     optional: a CSV with `patent` and `CPC Codes` columns, used to
//                        pre-filter by CPC WITHOUT fetching (patent_litigation_output_new.csv)
//   --patents <file>     optional: explicit patent numbers, one per line (bypasses filters)
// Filters (AND-ed; a patent must pass every one given)
//   --cpc G06F,H04L,...  CPC subclass/group prefixes (default: software/network/AI/database set)
//   --party <regex>      case_name must match (e.g. "Microsoft|Apple|Oracle|Google") -- either side
//   --plaintiff <regex>  the left side of "X v. Y" must match; the patent owner is usually the plaintiff,
//                        so this finds patents OWNED by the named parties rather than merely asserted against them
//                        (declaratory-judgment actions put the accused party on the left, so pair it with --assignee)
//   --assignee <regex>   patent OWNER. With --cpc-join, pre-filters on that file's `Assignees` column (patents with no
//                        recorded assignee are dropped and counted), then post-filters on the fetched page's original
//                        assignee. Without --cpc-join, post-filter only: every candidate is fetched; non-matching ones
//                        are cached but left out of the outputs.
//   --min-cases N        litigated in at least N distinct cases
//   --since YYYY         at least one case filed in or after YYYY
//   --rank cases|rate|recency   ordering. rate (default) = cases per year of
//                        exposure -- the citations-per-year correction, since a raw case count rewards old grants
//                        for having been around longer (grant year estimated from the patent number, first-number-of-year anchors,
//                        about +-1 month; the fetched page's real date is what the manifest reports). recency =
//                        case count decayed by filing date with half-life --half-life years (default 5).
//                        cases = the raw distinct case count.
//   --limit N            after ranking, keep N
//   --dry-run            print the ranked selection (patent, score, cases, est. grant year) and exit, no fetch
// Output (--out <dir>, default ./litig_claims_gp)
//   patents/<n>.json           per-patent cache (resume = re-run; cached patents are not refetched)
//   litigated_claims.jsonl     one record per patent: claim 1, its dependent chain, all claims, CPC, cases
//   litigated_claim1.txt       CE claims-only format (one claim 1 per line, # header)
//   manifest.csv               patent, title, first CPC, cases, claim-1 words, family-1 dependents, max depth
// Politeness: one request per --delay ms (default 2000), retry with backoff on 429/5xx,
// stop after 5 consecutive failures. Identify yourself in --ua if you change it.

import fs from 'node:fs';
import path from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; args[k] = v; }
}
const usage = () => { console.error(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(2); };
if (args['parse-html']) { // offline parser check on a saved page
  const r = parseGooglePatentPage(fs.readFileSync(args['parse-html'], 'utf8'), path.basename(args['parse-html']));
  console.log(JSON.stringify({ ...r, claims: (r.claims || []).map((c) => ({ n: c.n, dep: c.dependent, parent: c.parent, src: c.refSource, root: c.root, depth: c.depth, words: c.text.split(/\s+/).length, lines: c.lines.length })) }));
  process.exit(0);
}
if (args.help || (!args.litigation && !args.patents)) usage();

const OUT = args.out || './litig_claims_gp';
const DELAY = Number(args.delay || 2000);
const UA = args.ua || 'Mozilla/5.0 (compatible; CodeExam-claims-research/0.1; +https://github.com/aschulman42-cell/code-exam)';
const DEFAULT_CPC = 'G06F,G06N,G06Q,G06T,G06V,G06K,H04L,H04W,H04M,H04N21,H04N7,G10L,G16H';
const cpcPrefixes = (args.cpc || DEFAULT_CPC).split(',').map((s) => s.trim()).filter(Boolean);
const RANK = args.rank || 'rate';
if (!['cases', 'rate', 'recency'].includes(RANK)) { console.error(`--rank must be cases|rate|recency, got ${RANK}`); process.exit(2); }
const HALF_LIFE = Number(args['half-life'] || 5);

// First utility patent number issued in each year (USPTO issue-year table). Linear interpolation inside
// a year gives the grant date to about a month, which is all the exposure denominator needs.
const YEAR_ANCHORS = [[1990, 4890877], [1991, 4980178], [1992, 5077872], [1993, 5175962], [1994, 5274857],
  [1995, 5377930], [1996, 5479658], [1997, 5590420], [1998, 5704062], [1999, 5855020], [2000, 6009555],
  [2001, 6167569], [2002, 6334220], [2003, 6501275], [2004, 6671884], [2005, 6836652], [2006, 6981282],
  [2007, 7155746], [2008, 7313829], [2009, 7472428], [2010, 7640598], [2011, 7861317], [2012, 8087094],
  [2013, 8341762], [2014, 8621662], [2015, 8925549], [2016, 9226437], [2017, 9532496], [2018, 9854884],
  [2019, 10165721], [2020, 10524074], [2021, 10881042], [2022, 11212000], [2023, 11540000], [2024, 11856000]];
export function grantYearEstimate(patent) {
  const n = Number(patent); if (!Number.isFinite(n)) return null;
  if (n < YEAR_ANCHORS[0][1]) return 1990 - (YEAR_ANCHORS[0][1] - n) / 90000; // ~90k grants/yr in the late 80s
  for (let i = 0; i < YEAR_ANCHORS.length; i++) {
    const [y, first] = YEAR_ANCHORS[i]; const next = YEAR_ANCHORS[i + 1];
    if (!next || n < next[1]) return next ? y + (n - first) / (next[1] - first) : y + (n - first) / 330000;
  }
  return null;
}
const assigneeRx = args.assignee ? new RegExp(args.assignee, 'i') : null;

// --- minimal RFC4180 CSV -----------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ''])));
}
const csvCell = (s) => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s);

// --- selection ----------------------------------------------------------------
const cases = new Map(); // patent -> [{case_number, case_name, date_filed, district}]
if (args.litigation) {
  for (const r of parseCsv(fs.readFileSync(args.litigation, 'utf8'))) {
    const p = (r.patent || '').trim();
    if (!/^\d{7,8}$/.test(p)) continue; // utility numbers only; RE/D/PP skipped and counted below
    if (!cases.has(p)) cases.set(p, []);
    cases.get(p).push({ case_number: r.case_number, case_name: r.case_name, date_filed: r.date_filed, district: r.district_id });
  }
}
const cpcOf = new Map();
const assigneeOf = new Map();
if (args['cpc-join']) {
  for (const r of parseCsv(fs.readFileSync(args['cpc-join'], 'utf8'))) {
    const p = (r.patent || '').trim(); const c = (r['CPC Codes'] || '').trim();
    if (p && c && c !== 'N/A' && c !== 'NO!') cpcOf.set(p, c.split(';').map((x) => x.trim()));
    const a = (r.Assignees || '').trim();
    if (p && a && a !== 'N/A' && a !== 'NO!') assigneeOf.set(p, a);
  }
}
const hasCpc = (codes) => codes.some((c) => cpcPrefixes.some((pre) => c.startsWith(pre)));

let selected;
if (args.patents) {
  selected = fs.readFileSync(args.patents, 'utf8').split(/\r?\n/).map((l) => l.trim().replace(/^US/i, '')).filter((l) => /^\d{7,8}$/.test(l));
} else {
  const party = args.party ? new RegExp(args.party, 'i') : null;
  const plaintiff = args.plaintiff ? new RegExp(args.plaintiff, 'i') : null;
  const minCases = Number(args['min-cases'] || 1);
  const since = args.since ? String(args.since) : null;
  const dropped = { cpc: 0, party: 0, plaintiff: 0, assignee: 0, assigneeUnknown: 0, minCases: 0, since: 0, noCpcKnown: 0 };
  selected = [...cases.keys()].filter((p) => {
    const cs = cases.get(p);
    if (args['cpc-join']) {
      const codes = cpcOf.get(p);
      if (!codes) { dropped.noCpcKnown++; return false; }
      if (!hasCpc(codes)) { dropped.cpc++; return false; }
    }
    if (party && !cs.some((c) => party.test(c.case_name))) { dropped.party++; return false; }
    if (plaintiff && !cs.some((c) => plaintiff.test(String(c.case_name || '').split(/[ ]+v[.]?[ ]+/i)[0]))) { dropped.plaintiff++; return false; }
    if (assigneeRx && args['cpc-join']) {
      const a = assigneeOf.get(p);
      if (!a) { dropped.assigneeUnknown++; return false; }
      if (!assigneeRx.test(a)) { dropped.assignee++; return false; }
    }
    if (new Set(cs.map((c) => c.case_number)).size < minCases) { dropped.minCases++; return false; }
    if (since && !cs.some((c) => (c.date_filed || '') >= since)) { dropped.since++; return false; }
    return true;
  });
  // Ranking. `cases` is an EXPOSURE count: a 1998 patent has had 22 years to be asserted where a 2017 one
  // has had three, so it surfaces old IBM/Apple/Intel grants. `rate` divides by years of exposure (grant
  // to the end of the litigation data); `recency` weights each case by 0.5^(age / half-life).
  const yearOf = (d) => Number(String(d || '').slice(0, 4)) || 0;
  let dataEnd = 0; for (const cs of cases.values()) for (const c of cs) dataEnd = Math.max(dataEnd, yearOf(c.date_filed)); dataEnd += 1; // coverage ends at year end
  const score = (p) => {
    const cs = cases.get(p); const n = new Set(cs.map((c) => c.case_number)).size;
    if (RANK === 'cases') return n;
    if (RANK === 'rate') { const g = grantYearEstimate(p); return n / Math.max(1, dataEnd - (g ?? dataEnd - 1)); }
    return cs.reduce((acc, c) => acc + Math.pow(0.5, Math.max(0, dataEnd - 1 - yearOf(c.date_filed)) / HALF_LIFE), 0);
  };
  const scoreOf = new Map(selected.map((p) => [p, score(p)]));
  selected.sort((a, b) => scoreOf.get(b) - scoreOf.get(a)
    || (cases.get(b).map((c) => c.date_filed).sort().pop() || '').localeCompare(cases.get(a).map((c) => c.date_filed).sort().pop() || '')
    || Number(b) - Number(a));
  if (args['dry-run']) {
    const top = selected.slice(0, Number(args.limit || 40));
    console.log(`rank=${RANK}${RANK === 'recency' ? ` half-life=${HALF_LIFE}` : ''} dataEnd=${dataEnd} selected=${selected.length} (showing ${top.length})`);
    console.log('patent    score   cases  est.grant  assignee');
    for (const p of top) console.log(`${p.padEnd(9)} ${scoreOf.get(p).toFixed(2).padStart(6)} ${String(new Set(cases.get(p).map((c) => c.case_number)).size).padStart(6)}  ${(grantYearEstimate(p) ?? 0).toFixed(1)}     ${(assigneeOf.get(p) || '?').slice(0, 40)}`);
    process.exit(0);
  }
  process.stderr.write(`selection: ${cases.size} litigated utility patents -> ${selected.length} selected` +
    ` (dropped: cpc ${dropped.cpc}, no-cpc-known ${dropped.noCpcKnown}, party ${dropped.party}, plaintiff ${dropped.plaintiff}, assignee ${dropped.assignee}, assignee-unknown ${dropped.assigneeUnknown}, min-cases ${dropped.minCases}, since ${dropped.since})\n`);
  if (!args['cpc-join']) process.stderr.write('  NOTE: no --cpc-join given; CPC is taken from each fetched page instead of pre-filtering.\n');
}
if (args.limit) selected = selected.slice(0, Number(args.limit));

// --- fetch + parse ------------------------------------------------------------
function strip(h) { return h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim(); }

export function parseGooglePatentPage(html, patent) {
  const sec = html.match(/<section itemprop="claims"[\s\S]*?<\/section>/);
  if (!sec) return { patent, error: 'no claims section' };
  const s = sec[0];
  const claims = [];
  // Two markup generations: post-~2001 pages carry id="CLM-n" and <claim-ref>; older and reissue pages have only num="n" and flag dependents by the claim-dependent wrapper, so the parent must be read from the text.
  // Attribute order and id prefix vary by era: <div id="CLM-00001" num="00001" class="claim">, <div num="1" class="claim">, <div num="1" id="US-6384088-B1-CLM-00001" class="claim">.
  const re = /<div class="(claim|claim-dependent)">\s*<div (?=[^>]*\bnum="(\d+)")[^>]*class="claim">([\s\S]*?)(?=<div class="claim(?:-dependent)?">\s*<div |<\/section>|$)/g;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[2]); const body = m[3]; const wrapped = m[1] === 'claim-dependent';
    const refs = [...body.matchAll(/<claim-ref idref="[^"]*?CLM-(\d+)"/g)].map((x) => Number(x[1]));
    let refSource = refs.length ? 'claim-ref' : 'none';
    // element structure: each nested claim-text div is one line
    const lines = [...body.matchAll(/<div class="claim-text">([^<]*)/g)].map((x) => strip(x[1])).filter(Boolean);
    const text = strip(body).replace(/^\d+\s*\.\s*/, '');
    if (!refs.length && wrapped) { // dirty-data parent: "of claim 2", "according to claim 1", "as in 1"
      const tm = text.match(/\bclaims?\s+(\d+)/i) || text.match(/^(?:The|An?)\s[^,;]{0,120}?\b(?:of|in|to)\s+(\d+)\b/i);
      if (tm) { refs.push(Number(tm[1])); refSource = 'text'; }
    }
    claims.push({ n, text, lines, refs, refSource, dependent: wrapped || refs.length > 0, parent: refs[0] ?? null, multiParent: refs.length > 1 || /\b(any|one) of claims\b/i.test(text) });
  }
  const byN = new Map(claims.map((c) => [c.n, c]));
  const rootOf = (n, seen = 0) => { const c = byN.get(n); return !c || !c.dependent || seen > 50 ? n : rootOf(c.parent, seen + 1); };
  const depthOf = (n, seen = 0) => { const c = byN.get(n); return !c || !c.dependent || seen > 50 ? 0 : 1 + depthOf(c.parent, seen + 1); };
  for (const c of claims) { c.root = rootOf(c.n); c.depth = depthOf(c.n); }
  const codes = [...new Set([...html.matchAll(/<span itemprop="Code">([^<]+)<\/span>/g)].map((x) => x[1].trim()).filter((c) => c.includes('/')))];
  const title = (html.match(/<meta name="DC.title" content="([^"]*)"/) || [])[1] || '';
  const pubDate = (html.match(/itemprop="publicationDate"[^>]*>([^<]*)</) || [])[1] || (html.match(/<meta name="DC.date" content="([^"]*)"/) || [])[1] || '';
  const assignee = strip((html.match(/itemprop="assigneeOriginal"[^>]*>([^<]*)</) || [])[1] || '');
  const count = Number((html.match(/itemprop="count">(\d+)/) || [])[1] || claims.length);
  return { patent, title: strip(title), publicationDate: pubDate.trim(), assignee, cpc: codes, claimCount: count, claims };
}

async function fetchPage(patent) {
  const url = `https://patents.google.com/patent/US${patent}/en`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, redirect: 'follow' });
    if (res.ok) return { html: await res.text(), url: res.url };
    if (res.status === 404) return { error: `404 ${url}` };
    if (res.status === 429 || res.status >= 500) { const wait = DELAY * 2 ** attempt; process.stderr.write(`  ${patent}: http ${res.status}, backing off ${wait}ms\n`); await new Promise((r) => setTimeout(r, wait)); continue; }
    return { error: `http ${res.status} ${url}` };
  }
  return { error: `gave up after retries` };
}

fs.mkdirSync(path.join(OUT, 'patents'), { recursive: true });
let fetched = 0, cached = 0, failed = 0, consecutiveFail = 0;
const records = [];
for (let i = 0; i < selected.length; i++) {
  const p = selected[i];
  const cache = path.join(OUT, 'patents', `${p}.json`);
  let rec;
  if (fs.existsSync(cache)) { rec = JSON.parse(fs.readFileSync(cache, 'utf8')); cached++; }
  else {
    const got = await fetchPage(p);
    if (got.error) { rec = { patent: p, error: got.error }; failed++; consecutiveFail++; }
    else { rec = parseGooglePatentPage(got.html, p); rec.url = got.url; rec.fetchedAt = new Date().toISOString(); fetched++; consecutiveFail = rec.error ? consecutiveFail + 1 : 0; }
    fs.writeFileSync(cache, JSON.stringify(rec));
    process.stderr.write(`  [${i + 1}/${selected.length}] ${p}: ${rec.error ? 'FAILED ' + rec.error : `${rec.claims.length} claims, ${rec.claims.filter((c) => c.root === 1 && c.dependent).length} in claim-1 family`}\n`);
    if (consecutiveFail >= 5) { process.stderr.write('5 consecutive failures - stopping (rate limit or format change?)\n'); break; }
    if (i < selected.length - 1) await new Promise((r) => setTimeout(r, DELAY));
  }
  rec.cases = cases.get(p) || [];
  records.push(rec);
}

// --- outputs --------------------------------------------------------------------
// Who actually asserts the patent: the left side of each case name, most frequent first. The page's
// assignee is the ORIGINAL assignee (who drafted the claims); the plaintiff is often a later owner --
// the two 57-case IBM patents in the 2026-08-27 run were all Uniloc suits.
const plaintiffsOf = (cs) => { const n = new Map(); for (const c of cs) { const l = String(c.case_name || '').split(/[ ]+v[.]?[ ]+/i)[0].trim(); if (l) n.set(l, (n.get(l) || 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })); };
const okAll = records.filter((r) => !r.error && r.claims && r.claims.length);
const ok = assigneeRx ? okAll.filter((r) => assigneeRx.test(r.assignee || '')) : okAll;
if (assigneeRx) process.stderr.write(`assignee filter: ${ok.length} of ${okAll.length} fetched patents match /${args.assignee}/i
`);
const jsonl = ok.map((r) => {
  const c1 = r.claims.find((c) => c.n === 1);
  const fam = r.claims.filter((c) => c.root === 1 && c.dependent);
  return JSON.stringify({ patent: r.patent, url: r.url, title: r.title, publicationDate: r.publicationDate, assignee: r.assignee, cpc: r.cpc,
    plaintiffs: plaintiffsOf(r.cases),
    cases: r.cases.map((c) => ({ case_number: c.case_number, case_name: c.case_name, date_filed: c.date_filed })),
    claim1: c1 ? { text: c1.text, lines: c1.lines } : null,
    family1: fam.map((c) => ({ n: c.n, parent: c.parent, depth: c.depth, multiParent: c.multiParent, text: c.text })),
    allClaims: r.claims.map((c) => ({ n: c.n, parent: c.parent, root: c.root, depth: c.depth, text: c.text })) });
});
fs.writeFileSync(path.join(OUT, 'litigated_claims.jsonl'), jsonl.join('\n') + '\n');
const hdr = [`# Litigated-patent claim 1s, fetched from patents.google.com by litigated-claims-fetch.mjs`,
  `# Source litigation list: ${args.litigation || args.patents}`, `# Claims: ${ok.length}`, `# Dependents: in litigated_claims.jsonl (family1), NOT in this file`,
  `# Generated: ${new Date().toISOString()}`, `# Format: one claim per line`];
fs.writeFileSync(path.join(OUT, 'litigated_claim1.txt'), hdr.join('\n') + '\n' + ok.map((r) => (r.claims.find((c) => c.n === 1) || {}).text || '').filter(Boolean).join('\n') + '\n');
const man = ['patent,title,assignee,asserted_by,granted,cpc_first,cases,claim1_words,family1_dependents,family1_max_depth,independents,total_claims'];
for (const r of ok) {
  const c1 = r.claims.find((c) => c.n === 1); const fam = r.claims.filter((c) => c.root === 1 && c.dependent);
  const pl = plaintiffsOf(r.cases); const assertedBy = pl.length ? `${pl[0].name}${pl.length > 1 ? ` +${pl.length - 1}` : ''}` : '';
  man.push([r.patent, csvCell(r.title), csvCell(r.assignee || ''), csvCell(assertedBy), r.publicationDate || '', r.cpc[0] || '', new Set(r.cases.map((c) => c.case_number)).size, c1 ? c1.text.split(/\s+/).length : 0, fam.length, Math.max(0, ...fam.map((c) => c.depth)), r.claims.filter((c) => !c.dependent).length, r.claims.length].join(','));
}
fs.writeFileSync(path.join(OUT, 'manifest.csv'), man.join('\n') + '\n');
process.stderr.write(`done: ${fetched} fetched, ${cached} from cache, ${failed} failed -> ${OUT}/litigated_claims.jsonl (${ok.length} patents), litigated_claim1.txt, manifest.csv\n`);