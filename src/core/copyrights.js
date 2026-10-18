// copyrights.js — copyright/license notice harvest: holders normalized and counted, a first-vs-third presumption from counts, license documents apart
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * copyrights.js — the in-tree half of the dependency story
 * (copyright-notices-first-vs-third, #27, #124).
 *
 * The bill of materials sees foreign code only by directory name (vendor/,
 * third_party/, ...). A library copied into lib/, a renamed file or a pasted
 * function reads as the corpus's own code — and a copyright or license header
 * is the strongest in-tree evidence of foreign code wherever it sits. This
 * module reads those headers and says, with the evidence named, who the
 * holders are and which of them is presumptively this corpus.
 *
 * What is read:
 *   - the first HEADER_LINES lines of every indexed file, for notice lines
 *     (`Copyright (c) 2019-2024 Acme Corp`, `© 2020 The Foo Authors`,
 *     `SPDX-License-Identifier: MIT`, `Licensed under the Apache License`);
 *   - `/*! … *​/` banner comments anywhere in a file: a minified bundle carries
 *     one per package it contains, on a single very long line, so banners are
 *     read as bounded segments rather than as lines;
 *   - license documents (LICENSE, COPYING, NOTICE, THIRD-PARTY-NOTICES, ...),
 *     listed apart with the license they state: holders found there are not
 *     holders of the code around them.
 *
 * The presumption, disclosed as presumptive on every line that uses it: the
 * holder with the most files is presumptively first-party; every other holder
 * is presumptively third-party; a holder whose files all sit under a vendored
 * directory is third-party by location as well. Counts are the evidence the
 * index holds — the repository owner and the manifests name neither — and a
 * tie, or a single file, establishes nothing. #124's owner-versus-providers
 * idea is the later refinement.
 */

import { isLicenseDocName } from '../utils.js';
import { VENDOR_DIR_RE } from './imports.js';

export const HEADER_LINES = 60;
const MAX_NOTICE_LINE = 400;        // longer is a bundle or data, not a header line; banners are read separately
const DOC_EXTS = new Set(['', '.txt', '.md', '.rst', '.html', '.htm']);

// Comment leaders, in any mix: // # * /* <!-- -- ; % ' " | @REM
const LEADER_RE = /^[\s/*#<!\-;%'"|@]*(?:rem\b)?[\s/*#<!\-;%'"|@]*/i;
// The word, the symbol, or "(c)" with a year beside it. "(c)" alone is an
// enumeration label ("(c) conducting a procedure", the Apache license's own
// list) or a JavaScript arrow parameter ("filter((c) => …)"), as a run over
// CodeExam's tree showed.
const NOTICE_WORD_RE = /\bcopyright\b|©|\(c\)\s*(?:19|20)\d{2}\b/i;
const YEAR_RE = /\b(?:19|20)\d{2}\b/;
// "copyright" as a word in prose, not a holder line: "the above copyright
// notice", "copyright holders", "copyright law", "copyright license to".
const PROSE_AFTER_COPYRIGHT_RE = /^copyright\s+(?:notices?|and|or|holders?|owners?|law|laws|licen[cs]es?|statement|header|information|infringement|interest|protection|year|date|symbol|line|string|text|message|is|are|in|of|to|for|on|by\s+law)\b/i;
// A license template's placeholder, not a holder: "Copyright [yyyy] [name of copyright owner]".
const PLACEHOLDER_RE = /\[(?:yyyy|year|name)|<(?:year|name|owner|holder)>|\byyyy\b|\bname of (?:copyright )?owner\b/i;

const LICENSE_PATTERNS = [
  [/SPDX-License-Identifier:\s*([\w.+-]+(?:\s+(?:OR|AND|WITH)\s+[\w.+-]+)*)/i, (m) => m[1]],
  [/Apache License,?\s*(?:Version\s*)?2\.0|Apache-2\.0/i, () => 'Apache-2.0'],
  [/\bMIT License\b|Permission is hereby granted, free of charge/i, () => 'MIT'],
  [/\bISC License\b/i, () => 'ISC'],
  [/BSD[- ](\d)-Clause|Redistribution and use in source and binary forms/i, (m) => (m[1] ? `BSD-${m[1]}-Clause` : 'BSD')],
  [/GNU Lesser General Public License(?:[^\n]*?version\s*(\d(?:\.\d)?))?/i, (m) => (m[1] ? `LGPL-${m[1]}` : 'LGPL')],
  [/GNU Affero General Public License(?:[^\n]*?version\s*(\d(?:\.\d)?))?/i, (m) => (m[1] ? `AGPL-${m[1]}` : 'AGPL')],
  [/GNU General Public License(?:[^\n]*?version\s*(\d(?:\.\d)?))?/i, (m) => (m[1] ? `GPL-${m[1]}` : 'GPL')],
  [/Mozilla Public License(?:,?\s*v(?:ersion)?\.?\s*(\d(?:\.\d)?))?/i, (m) => (m[1] ? `MPL-${m[1]}` : 'MPL')],
  [/\bThe Unlicense\b|\bUNLICENSE\b/, () => 'Unlicense'],
  [/Creative Commons|\bCC[- ]BY\b/i, () => 'CC'],
  [/Boost Software License/i, () => 'BSL-1.0'],
  [/Eclipse Public License/i, () => 'EPL'],
];

/** The license a block of text states, or null. SPDX first, then the common phrasings. */
export function licenseOf(text) {
  const t = String(text || '');
  for (const [re, name] of LICENSE_PATTERNS) {
    const m = re.exec(t);
    if (m) return name(m);
  }
  return null;
}

/**
 * The holder named on one notice line, normalized for display, or null when
 * the line is not a holder line. Years and ranges, the word and the symbols,
 * "All rights reserved" and comment leaders are stripped; the rest is the
 * holder as written. "(unnamed)" when a line says only "Copyright 2020".
 */
export function holderFromLine(line, { banner = false } = {}) {
  let s = String(line || '').replace(/\r+$/, '');
  if (s.length > MAX_NOTICE_LINE) return null;
  // Inside a /*! banner "(c) OpenJS Foundation" is a notice without a year
  // (jQuery's own); in a header line "(c)" needs a year beside it.
  if (!NOTICE_WORD_RE.test(s) && !(banner && /\(c\)\s*[A-Za-z@]/i.test(s))) return null;
  s = s.replace(/\*\/\s*$/, '').replace(/-->\s*$/, '').replace(LEADER_RE, '').trim();
  if (PLACEHOLDER_RE.test(s)) return null;
  const hasMark = /\(c\)\s*(?:19|20)\d{2}\b|©/i.test(s) || YEAR_RE.test(s) || (banner && /\(c\)\s*[A-Za-z@]/i.test(s));
  if (!hasMark) {
    // No symbol and no year: only a line that *starts* with "Copyright <name>" counts
    // (jQuery's banner: "Copyright OpenJS Foundation and other contributors").
    if (!/^(?:portions\s+)?copyright\s+\S/i.test(s) || PROSE_AFTER_COPYRIGHT_RE.test(s)) return null;
  } else if (/^copyright\s+(?:notices?|holders?|owners?|law)\b/i.test(s)) {
    return null;
  }
  s = s.replace(/\b(?:portions\s+)?copyright\b\s*:?/gi, ' ').replace(/\(c\)|©/gi, ' ');
  s = s.replace(/\b(?:19|20)\d{2}\s*(?:[-–—,/]\s*(?:(?:19|20)\d{2}|present|now)?\s*)*/gi, ' ');
  s = s.replace(/\ball rights reserved\b\.?/gi, ' ');
  s = s.replace(/^\s*by\s+/i, ' ');
  s = s.replace(/\s+/g, ' ').replace(/^[\s,.:;\-–—]+|[\s,.:;\-–—]+$/g, '').trim();
  return s || '(unnamed)';
}

// One key per holder across spellings: case, punctuation, corporate suffixes
// and "The … Authors/contributors" glue collapsed.
export function holderKey(holder) {
  return String(holder || '').toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/\(https?:[^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:inc|llc|ltd|limited|corp|corporation|co|gmbh|ag|sa|srl|pty|plc|the|and|its|contributors|authors|other|others|et al|team)\b/g, ' ')
    .replace(/\s+/g, ' ').trim() || holder.toLowerCase();
}

/**
 * The harvest over a loaded index. Returns
 *   { scanned, withNotice, noNotice, holders: [{ holder, key, files, sites, example,
 *     embeddedOnly, vendoredFiles, presumption, reason }], dominant, tie,
 *     licenses: [{ id, files }], documents: [{ file, license }], bundles: [{ file, holders }] }
 */
export function copyrightNotices(index, { headerLines = HEADER_LINES } = {}) {
  const holders = new Map();
  const licenses = new Map();
  const documents = [];
  const bundles = [];
  let scanned = 0;
  let withNotice = 0;
  const note = (holder, file, line, embedded, raw) => {
    const key = holderKey(holder);
    let h = holders.get(key);
    if (!h) { h = { key, spellings: new Map(), files: new Set(), vendoredFiles: new Set(), sites: [], embedded: 0, total: 0, example: raw }; holders.set(key, h); }
    h.spellings.set(holder, (h.spellings.get(holder) || 0) + 1);
    h.files.add(file);
    if (VENDOR_DIR_RE.test(file)) h.vendoredFiles.add(file);
    h.total++;
    if (embedded) h.embedded++;
    if (h.sites.length < 5) h.sites.push({ file, line, embedded });
    return key;
  };
  for (const [file, lines] of index.fileLines) {
    const base = String(file).split(/[\\/]/).pop();
    const ext = (base.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (isLicenseDocName(base) && DOC_EXTS.has(ext)) {
      const text = (lines || []).slice(0, 200).join('\n');
      const named = [];
      for (const l of (lines || []).slice(0, 200)) { const h = holderFromLine(l); if (h && !named.includes(h)) named.push(h); if (named.length >= 5) break; }
      documents.push({ file, license: licenseOf(text) || 'unrecognized', holders: named });
      continue;
    }
    scanned++;
    const head = (lines || []).slice(0, headerLines);
    const fileHolders = new Set();
    for (let i = 0; i < head.length; i++) {
      const h = holderFromLine(head[i]);
      if (h) fileHolders.add(note(h, file, i + 1, false, String(head[i]).trim().slice(0, 160)));
    }
    // Banners anywhere: a bundle's notices sit on one long line, so read
    // bounded /*! … */ segments and split them on the separators bundlers use.
    for (let i = 0; i < (lines || []).length; i++) {
      const l = lines[i];
      if (!l || l.indexOf('/*!') < 0) continue;
      if (i < headerLines && l.length <= MAX_NOTICE_LINE) continue;   // a short banner line in the header was read above
      const re = /\/\*![\s\S]{0,600}?\*\//g;
      let m;
      while ((m = re.exec(l))) {
        for (const piece of m[0].split(/\s*\|\s*|\s*\*\s+|\n/)) {
          const h = holderFromLine(piece, { banner: true });
          if (h) fileHolders.add(note(h, file, i + 1, true, piece.trim().slice(0, 160)));
        }
      }
    }
    if (fileHolders.size) withNotice++;
    if (fileHolders.size >= 3) bundles.push({ file, holders: fileHolders.size });
    const lic = licenseOf(head.join('\n'));
    if (lic) { if (!licenses.has(lic)) licenses.set(lic, new Set()); licenses.get(lic).add(file); }
  }
  const list = [...holders.values()].map((h) => {
    const spelling = [...h.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    return {
      holder: spelling, key: h.key, files: h.files.size, spellings: h.spellings.size,
      sites: h.sites, example: h.example, embeddedOnly: h.embedded === h.total,
      vendoredFiles: h.vendoredFiles.size, allVendored: h.files.size > 0 && h.vendoredFiles.size === h.files.size,
    };
  }).sort((a, b) => b.files - a.files || a.holder.localeCompare(b.holder));
  const tie = list.length >= 2 && list[0].files === list[1].files;
  const dominant = list.length && list[0].files >= 2 && !tie ? list[0] : null;
  for (const h of list) {
    if (dominant && h.key === dominant.key) {
      h.presumption = 'first-party';
      h.reason = `most files carry it (${h.files} of ${withNotice} with a notice); derived from counts, not knowledge`;
      if (h.vendoredFiles) h.reason += `; ${h.vendoredFiles} of its files sit under a vendored directory`;
    } else if (h.allVendored) {
      h.presumption = 'third-party';
      h.reason = 'every file under a vendored directory';
    } else if (tie && list[0].files === h.files) {
      h.presumption = 'undetermined';
      h.reason = `tied for most files (${h.files}); counts cannot pick a first party`;
    } else if (!dominant && !tie) {
      h.presumption = 'undetermined';
      h.reason = list.length === 1 ? 'the only holder, on one file; one file establishes nothing' : 'no holder has two files; counts cannot pick a first party';
    } else {
      h.presumption = 'third-party';
      h.reason = h.embeddedOnly ? `named only in embedded banners (${h.files} bundle file(s))` : `fewer files than the presumptive first party (${h.files})`;
    }
  }
  return {
    scanned, withNotice, noNotice: scanned - withNotice,
    holders: list, dominant, tie,
    licenses: [...licenses.entries()].map(([id, files]) => ({ id, files: files.size })).sort((a, b) => b.files - a.files || a.id.localeCompare(b.id)),
    documents, bundles: bundles.sort((a, b) => b.holders - a.holders),
  };
}
