// copyrights.js — --copyrights: the copyright-holder table, presumptive first vs third party, licenses and license documents
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * --copyrights (copyright-notices-first-vs-third): the full table that
 * --bom's capped "Copyright holders" section points at. Holder, files,
 * presumption (first-party / third-party / undetermined, always marked
 * presumptive), one example site; -v adds the sites and the spellings;
 * --filter matches the holder or a path; --max-results caps the table.
 * Then the license identifiers seen per file, the license documents apart
 * (LICENSE, NOTICE, ...), and the bundle files that carry several holders'
 * banners.
 */

import { effectiveMaxResults, capNotice } from '../argparse.js';
import { makeFilterMatcher } from '../core/filter-match.js';
import { copyrightNotices } from '../core/copyrights.js';

const CAP = 40;

export function doCopyrights(index, args) {
  const cr = copyrightNotices(index);
  console.log(`Copyright holders — ${index.indexPath}`);
  console.log(`  ${cr.scanned} file(s) scanned; ${cr.withNotice} carry a notice in the first 60 lines or a /*! banner; ${cr.noNotice} carry none\n`);
  const match = args.filter ? makeFilterMatcher(args.filter) : null;
  const rows = cr.holders.filter((h) => !match || match(h.holder) || h.sites.some((s) => match(s.file)));
  if (!rows.length) {
    console.log(cr.holders.length ? `  No holder matches --filter '${args.filter}'.` : '  No copyright notices found in file headers or banners.');
  } else {
    const cap = effectiveMaxResults(args, CAP);
    const shown = rows.slice(0, cap);
    console.log('  files  presumption   holder                                      e.g.');
    for (const h of shown) {
      const eg = h.sites[0] ? `${h.sites[0].file}:${h.sites[0].line}${h.sites[0].embedded ? ' (banner)' : ''}` : '';
      console.log(`  ${String(h.files).padStart(5)}  ${h.presumption.padEnd(12)}  ${h.holder.slice(0, 42).padEnd(42)}  ${eg}`);
      if (args.verbose) {
        console.log(`${' '.repeat(9)}why: ${h.reason}`);
        if (h.spellings > 1) console.log(`${' '.repeat(9)}${h.spellings} spellings; as written: ${h.example}`);
        for (const s of h.sites.slice(1)) console.log(`${' '.repeat(9)}also ${s.file}:${s.line}${s.embedded ? ' (banner)' : ''}`);
      }
    }
    const note = capNotice(rows.length, Math.min(cap, rows.length), 'holders');
    if (note) console.log('\n' + note + '  (or narrow with --filter <holder or path>)');
    console.log('');
    if (cr.dominant) {
      console.log(`  Presumption: ${cr.dominant.holder} is presumptively first-party — ${cr.dominant.reason}.`);
      console.log('  Every other holder is presumptively third-party; one whose files all sit under a vendored directory is third-party by location too.');
    } else if (cr.tie) {
      console.log('  Presumption: none — the top holders tie on file count, and counts are all the index holds.');
    } else {
      console.log('  Presumption: none — no holder has two files.');
    }
  }
  if (cr.licenses.length) {
    console.log('');
    console.log(`License identifiers in file headers: ${cr.licenses.map((l) => `${l.id} (${l.files})`).join(', ')}`);
  }
  if (cr.documents.length) {
    console.log('');
    console.log('License documents (listed apart; their holders are not the holders of the code around them):');
    for (const d of cr.documents) console.log(`  ${d.file} — ${d.license}${d.holders.length ? `; names ${d.holders.join('; ')}` : ''}`);
  }
  if (cr.bundles.length) {
    console.log('');
    console.log('Bundles with embedded notices (one file, several holders; the file is evidence of a bundle, not of one library):');
    for (const b of cr.bundles.slice(0, 10)) console.log(`  ${b.file} — ${b.holders} holders`);
    if (cr.bundles.length > 10) console.log(`  ... and ${cr.bundles.length - 10} more`);
  }
  console.log('');
  console.log('Coverage: the first 60 lines of every indexed file and /*! banners anywhere in it; license');
  console.log('documents are read whole. A holder is "as written", with years, symbols and "All rights');
  console.log('reserved" removed; spellings that differ only in case, punctuation or a corporate suffix');
  console.log('are one holder. First-party is a presumption from file counts, never a finding.');
}
