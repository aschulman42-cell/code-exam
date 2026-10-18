// test_copyrights.js — the copyright-notice harvest: holder normalization, the first-vs-third presumption, banners, license documents, the two commands
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// copyright-notices-first-vs-third: what is asserted is the RULE and its
// stated reason — never a guess. First-party is a presumption from counts and
// says so on the line; a tie or a single file establishes nothing.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { holderFromLine, holderKey, licenseOf, copyrightNotices } from '../src/core/copyrights.js';
import { doCopyrights } from '../src/commands/copyrights.js';
import { doBom } from '../src/commands/imports.js';

const capture = (fn) => {
  const out = [];
  const orig = console.log; console.log = (s) => out.push(String(s));
  try { fn(); } finally { console.log = orig; }
  return out.join('\n');
};

const corpus = () => ({
  indexPath: '.corp',
  fileLines: new Map([
    ['src/a.js', ['// Copyright (c) 2019-2024 Acme Corp', '// Licensed under the Apache License, Version 2.0', 'export const a = 1;']],
    ['src/b.js', ['/* Copyright © 2020 Acme Corp. All rights reserved. */', 'export const b = 2;']],
    ['src/c.py', ['# copyright 2021, ACME CORP, INC.', 'import os']],
    ['src/d.cs', ['// Copyright 2022 by Acme Corporation', 'namespace Acme {}']],
    ['tools/run.bat', ['@REM Copyright (c) 2023 Acme Corp', '@echo off']],
    ['lib/lodash.min.js', ['/*! lodash v4.17.21 | (c) 2012-2021 JS Foundation and other contributors | MIT License */' + 'x'.repeat(500)]],
    ['third_party/venlib/ven.c', ['/* Copyright (c) 2015 Vendor Labs Ltd */', 'int v;']],
    ['src/e.js', ['// no notice here', "// the above copyright notice and this permission notice shall be included", 'export const e = 5;']],
    ['test/fixture.js', ['const s = "Copyright (c) 2001 Decoy Inc";']],
    ['LICENSE', ['Apache License', 'Version 2.0, January 2004', 'Copyright 2026 Acme Corp']],
    ['NOTICE', ['This product includes software developed by Someone Else (c) 2010.']],
    ['public/vendor/bundle.min.js', ['/*! jQuery v3.7.1 | (c) OpenJS Foundation and other contributors | jquery.org/license */ /*! Sizzle v2.3.10 | (c) JS Foundation and other contributors */ /*! Mermaid v11 | (c) 2024 Knut Sveidqvist */' + 'y'.repeat(400)]],
  ]),
});

describe('holder lines and normalization', () => {
  it('a dozen spellings of one holder collapse to one key; years, symbols and suffixes go', () => {
    const lines = [
      '// Copyright (c) 2019-2024 Acme Corp',
      '/* Copyright © 2020 Acme Corp. All rights reserved. */',
      '# copyright 2021, ACME CORP, INC.',
      '// Copyright 2022 by Acme Corporation',
      '@REM Copyright (c) 2023 Acme Corp',
      '<!-- (c) 2018-present Acme Corp, Inc. -->',
      '-- Copyright: 2017 The Acme Corp Authors',
      "' Copyright (C) 1999, 2001 Acme Corp.",
    ];
    const keys = new Set(lines.map((l) => holderKey(holderFromLine(l))));
    assert.deepEqual([...keys], ['acme'], `keys: ${[...keys].join(' | ')}`);
    assert.equal(holderFromLine('// Copyright (c) 2019-2024 Acme Corp'), 'Acme Corp');
    assert.equal(holderFromLine('# Copyright 2020'), '(unnamed)');
  });

  it('prose that merely contains the word is not a holder line; a bare "Copyright <name>" is', () => {
    assert.equal(holderFromLine('// the above copyright notice and this permission notice shall be included'), null);
    assert.equal(holderFromLine('// copyright holders shall not be liable'), null);
    assert.equal(holderFromLine('// see the copyright law of your country'), null);
    assert.equal(holderFromLine(' * Copyright OpenJS Foundation and other contributors'), 'OpenJS Foundation and other contributors');
    assert.equal(holderFromLine('x'.repeat(401) + ' copyright (c) 2020 Big'), null, 'a very long line is data, not a header');
    // A decoy inside code is still a holder line, "as written" (the code around it stays, so the site tells).
    assert.match(holderFromLine('const s = "Copyright (c) 2001 Decoy Inc";'), /^const s = " ?Decoy Inc"$/);
  });

  it('licenseOf reads SPDX first, then the common phrasings', () => {
    assert.equal(licenseOf('// SPDX-License-Identifier: MIT OR Apache-2.0'), 'MIT OR Apache-2.0');
    assert.equal(licenseOf('Licensed under the Apache License, Version 2.0 (the "License")'), 'Apache-2.0');
    assert.equal(licenseOf('Permission is hereby granted, free of charge, to any person'), 'MIT');
    assert.equal(licenseOf('Redistribution and use in source and binary forms'), 'BSD');
    assert.equal(licenseOf('under the terms of the GNU General Public License as published by the Free Software Foundation; either version 2'), 'GPL-2');
    assert.equal(licenseOf('This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0'), 'MPL-2.0');
    assert.equal(licenseOf('nothing here'), null);
  });
});

describe('the harvest over a corpus', () => {
  it('counts holders across spellings, presumes the dominant one first-party with its reason, the rest third-party', () => {
    const cr = copyrightNotices(corpus());
    const by = (key) => cr.holders.find((h) => h.key === key);
    assert.equal(cr.scanned, 10, 'license documents are not scanned as code');
    assert.deepEqual([cr.withNotice, cr.noNotice], [9, 1]);
    const acme = by('acme');
    assert.ok(acme, 'acme holder');
    // Five files, three display spellings ("Acme Corp" twice and from the .bat, "ACME CORP, INC", "Acme Corporation"), one key.
    assert.deepEqual([acme.files, acme.spellings, acme.presumption], [5, 3, 'first-party']);
    assert.match(acme.reason, /most files carry it \(5 of 9 with a notice\); derived from counts, not knowledge/);
    assert.equal(cr.dominant.key, 'acme');
    const vendor = by('vendor labs');
    assert.deepEqual([vendor.presumption, vendor.reason], ['third-party', 'every file under a vendored directory']);
    // The decoy keeps the code around it in its name ("const s decoy"), so its site and its name both tell.
    const decoy = cr.holders.find((h) => /decoy/.test(h.key));
    assert.deepEqual([decoy.presumption, decoy.sites[0].file], ['third-party', 'test/fixture.js']);
  });

  it('banners inside one bundle file yield several holders, marked embedded, and the file is listed as a bundle', () => {
    const cr = copyrightNotices(corpus());
    assert.deepEqual(cr.bundles, [{ file: 'public/vendor/bundle.min.js', holders: 3 }]);
    const openjs = cr.holders.find((h) => /openjs/.test(h.key));
    assert.ok(openjs && openjs.embeddedOnly && openjs.sites[0].embedded, 'a banner-only holder is marked embedded');
    assert.match(openjs.reason, /every file under a vendored directory|named only in embedded banners/);
    const lodash = cr.holders.find((h) => /js foundation/.test(h.key));
    assert.ok(lodash, 'the lodash banner on a long line in lib/ is read as a banner segment');
  });

  it('license documents are listed apart with the license they state; identifiers are counted per file', () => {
    const cr = copyrightNotices(corpus());
    assert.deepEqual(cr.documents.map((d) => [d.file, d.license]), [['LICENSE', 'Apache-2.0'], ['NOTICE', 'unrecognized']]);
    assert.ok(cr.documents[0].holders.includes('Acme Corp'));
    assert.deepEqual(cr.licenses, [{ id: 'Apache-2.0', files: 1 }, { id: 'MIT', files: 1 }]);
    assert.ok(!cr.holders.some((h) => /someone else/.test(h.key)), 'a NOTICE file\'s holder is not a holder of the code');
  });

  it('a tie or a single file establishes no first party, and says so', () => {
    const tie = copyrightNotices({ fileLines: new Map([['a.js', ['// (c) 2020 One']], ['b.js', ['// (c) 2020 Two']]]) });
    assert.equal(tie.dominant, null);
    assert.ok(tie.tie);
    assert.deepEqual(tie.holders.map((h) => h.presumption), ['undetermined', 'undetermined']);
    const single = copyrightNotices({ fileLines: new Map([['a.js', ['// (c) 2020 One']], ['b.js', ['export const b = 1;']]]) });
    assert.equal(single.dominant, null);
    assert.match(single.holders[0].reason, /one file establishes nothing/);
  });
});

describe('the commands', () => {
  it('--copyrights prints the table with the presumption marked, then licenses, documents and bundles', () => {
    const text = capture(() => doCopyrights(corpus(), { _explicit: new Set() }));
    assert.match(text, /Copyright holders — \.corp/);
    assert.match(text, /10 file\(s\) scanned; 9 carry a notice/);
    assert.match(text, /^\s+5\s+first-party\s+Acme Corp\s+src\/a\.js:1/m);
    assert.match(text, /third-party\s+Vendor Labs Ltd\s+third_party\/venlib\/ven\.c:1/);
    assert.match(text, /Presumption: Acme Corp is presumptively first-party — most files carry it/);
    assert.match(text, /License identifiers in file headers: Apache-2\.0 \(1\), MIT \(1\)/);
    assert.match(text, /LICENSE — Apache-2\.0; names Acme Corp/);
    assert.match(text, /public\/vendor\/bundle\.min\.js — 3 holders/);
    assert.match(text, /First-party is a presumption from file counts, never a finding\./);
    const v = capture(() => doCopyrights(corpus(), { _explicit: new Set(), verbose: true, filter: 'acme' }));
    assert.match(v, /why: most files carry it/);
    assert.match(v, /3 spellings; as written: \/\/ Copyright \(c\) 2019-2024 Acme Corp/);
    assert.doesNotMatch(v, /Vendor Labs/, '--filter narrows the table');
  });

  it('--bom carries a capped Copyright holders section beside the external surface', () => {
    const text = capture(() => doBom(corpus(), { _explicit: new Set() }));
    assert.match(text, /Copyright holders \(in-tree provenance; presumptive, from counts — --copyrights lists all\):/);
    assert.match(text, /first-party\s+Acme Corp\s+5 file\(s\)/);
    assert.match(text, /third-party\s+Vendor Labs Ltd\s+1 file\(s\), e\.g\. third_party\/venlib\/ven\.c:1/);
    assert.match(text, /1 file\(s\) carry no notice; license documents: LICENSE \(Apache-2\.0\), NOTICE \(unrecognized\); 1 bundle file\(s\)/);
  });
});
