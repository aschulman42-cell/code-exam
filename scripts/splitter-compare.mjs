#!/usr/bin/env node
// splitter-compare.mjs -- CE's claim rows beside the drafting attorney's, for one litigated patent
// from test/fixtures/litigated-claim1-structure.jsonl. The eyeball companion to the pinned
// calibration numbers in test_claim_locate.js: the numbers say how often the tiers agree with
// the attorney; this shows what the disagreement looks like on a claim you can read.
//
// usage: node scripts/splitter-compare.mjs [patent] [--granularity fine|coarse]
//   default patent 7703036 (Microsoft, ribbon UI -- the fragment case before f2179ab);
//   9032076 (IBM, RBAC) shows the coarse under-split: two attorney "wherein" rows comma-joined in the text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitClaimElements } from '../src/commands/claim-locate.js';

const args = process.argv.slice(2);
const gi = args.indexOf('--granularity');
const tier = gi >= 0 ? (args[gi + 1] || 'fine') : (args.includes('coarse') ? 'coarse' : 'fine');
const patent = (args.find((a) => /^(US)?\d{7,8}$/i.test(a)) || '7703036').replace(/^US/i, '');
if (!['fine', 'coarse'].includes(tier)) { console.error(`--granularity must be fine or coarse, got ${tier}`); process.exit(2); }

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'test', 'fixtures', 'litigated-claim1-structure.jsonl');
const recs = fs.readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const r = recs.find((x) => x.patent === patent);
if (!r) { console.error(`patent ${patent} is not in the fixture; e.g. ${recs.slice(0, 8).map((x) => x.patent).join(' ')}`); process.exit(1); }

const txt = (e) => (typeof e === 'string' ? e : (e && (e.text || e.raw)) || String(e));
const rows = splitClaimElements(r.text, { fine: tier !== 'coarse' });
const W = Math.max(60, Math.min(110, process.stdout.columns ? process.stdout.columns - 14 : 100));
const clip = (s) => `${s.slice(0, W)}${s.length > W ? '…' : ''}`;
console.log(`US ${r.patent} (${r.assignee}, granted ${r.granted})  attorney rows ${r.lines.length}   CE --granularity ${tier}: ${rows.length} rows\n`);
console.log('ATTORNEY (the claim-text divs on patents.google.com):');
r.lines.forEach((l, i) => console.log(`  [${String(i + 1).padStart(2)}] ${clip(l)}`));
console.log(`\nCE splitClaimElements, ${tier}:`);
rows.forEach((e, i) => console.log(`  (${String(i + 1).padStart(2)}) ${clip(txt(e))}`));
