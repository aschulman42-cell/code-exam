// test_recap_claim_chart_search.js — the citation pass and the catalog renderer of scripts/recap-claim-chart-search.mjs, no network
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// Fixtures are lines read out of real public filings on 2026-10-20 (docs/real-world-claim-charts.md):
// the Uniswap complaint's file-and-function citation, the Hugging Face directory link, the Bitcoin
// BIP (a document, not code), a kubernetes.io documentation link (not a repository at all); and,
// for code quoted by name with no link, the Spark, secp256k1 and openh264 lines a grep of the first
// run's texts for empty parentheses found.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepoUrl, granularityOf, citationsOf, docDomains, summarizeText, functionNear, patentNear, claimNear, flatten,
  codeShapedCall, codeMentions, parseLabel, columnBoundary, chartRows, paragraphsOf, layoutOf, renderCites, patentsIn, CODE_QUOTED_MIN,
  renderCatalog, replaceSection, catalogRow, parseArgs, QUERY_SHAPES, GRANULARITY_RANK, CATALOG_START, CATALOG_END,
  alignToClaim, preambleOf, claimClauses, applyClaims, claimBlockOf, claimSourceFor, claimShapedQuote, shortPatentsIn, resolveAcrossDocket,
} from '../scripts/recap-claim-chart-search.mjs';

const UNISWAP = 'The number of LP tokens received is equal to the number of reserve tokens deposited divided by the price of one LP token. '
  + 'The publication includes claim 4 which recites the same limitations as claim 1 of the \'049 patent (U.S. Patent No. 11,322,049). '
  + '34 See, e.g., https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol\n(function "mint") (last visited May 12, 2025).';

describe('repository links: what a citation points at', () => {
  it('a blob link to a source file is file-level; a tree link is a directory; a README anchor is the repository', () => {
    const f = parseRepoUrl('https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol');
    assert.deepEqual([f.org, f.repo, f.kind, f.ref, f.path, f.granularity], ['Uniswap', 'v2-core', 'blob', 'master', 'contracts/UniswapV2Pair.sol', 'file']);
    assert.equal(parseRepoUrl('https://github.com/huggingface/text-generation-inference/tree/main/router').granularity, 'directory');
    assert.equal(parseRepoUrl('https://github.com/huggingface/text-generation-inference#features').granularity, 'repo');
    assert.equal(parseRepoUrl('https://github.com/huggingface/text-generation-inference').granularity, 'repo');
  });
  it('a line anchor is line-level; a markdown or mediawiki file is a document, not code; raw and gitlab links parse too', () => {
    const l = parseRepoUrl('https://github.com/org/repo/blob/abc123/src/x.go#L12-L30');
    assert.equal(l.granularity, 'line'); assert.equal(l.ref, 'abc123'); assert.equal(l.path, 'src/x.go');
    assert.equal(parseRepoUrl('https://github.com/bitcoin/bips/blob/master/bip-0137.mediawiki').granularity, 'document');
    assert.equal(parseRepoUrl('https://raw.githubusercontent.com/org/repo/main/a/b.py').granularity, 'file');
    assert.equal(parseRepoUrl('https://gitlab.com/group/proj/-/blob/main/src/a.rs').granularity, 'file');
    assert.equal(parseRepoUrl('https://kubernetes.io/docs/concepts/workloads/pods/'), null);
    assert.equal(granularityOf(null), 'none');
  });
  it('trailing punctuation from prose is not part of the path, nor of a bare repository name', () => {
    assert.equal(parseRepoUrl('https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol).').path, 'contracts/UniswapV2Pair.sol');
    // TwinStrand v. Guardant, Dkt 30: "https://github.com/loeblab/Duplex-Sequencing." ends a sentence.
    assert.equal(parseRepoUrl('https://github.com/loeblab/Duplex-Sequencing.').repo, 'Duplex-Sequencing');
  });
});

describe('the citation pass over a filing', () => {
  it('reads the Uniswap line: file link, the named function, the nearest patent and claim', () => {
    const cs = citationsOf(UNISWAP);
    assert.equal(cs.length, 1);
    const c = cs[0];
    assert.equal(c.granularity, 'function');
    assert.equal(c.function, 'mint');
    assert.equal(c.patent, '11,322,049', 'the full number wins over the shorthand');
    assert.equal(c.claim, '1');
  });
  it('functionNear reads Go and JavaScript spellings too; patentNear falls back to the shorthand', () => {
    assert.equal(functionNear('x https://g/ func (s *T) Serve(w) {', 2, 10), 'Serve');
    assert.equal(functionNear('see https://g/ where handleRequest() does the work', 4, 10), 'handleRequest');
    assert.equal(patentNear("claim 2 of the '582 patent, see https://g/", 40), "'582");
    assert.equal(claimNear('nothing here', 0), null);
  });
  it('what the first run taught: prose after "function" is not a name, a comma number is not a patent, a wrapped URL is not a file', () => {
    // VM Innovations v. Coinbase, Dkt 1-23: "the function to transfer" read as a function named "to".
    assert.equal(functionNear('see https://g/ which provides the function to transfer tokens', 4, 10), null);
    // Valtrus v. Google, Dkt 1-7: "4,503,495" beside the link was a count, not a patent; the patent sits by the word.
    assert.equal(patentNear('over 4,503,495 lines https://g/ in the kernel', 21), null);
    assert.equal(patentNear("U.S. Patent No. 9,948,712 claim 16 reads on https://g/", 44), '9,948,712');
    assert.equal(patentNear("the 9,948,712 patent (the '712 patent) https://g/", 39), '9,948,712');
    // Sandpiper v. Cox, Dkt 1: a URL wrapped across PDF lines left a path of ".m".
    assert.equal(parseRepoUrl('https://github.com/apache/trafficcontrol/blob/master/.m').granularity, 'directory');
    assert.equal(parseRepoUrl('https://github.com/apache/trafficcontrol/blob/master/lib/go-tc/.m').granularity, 'directory');
    // Sandpiper again: "init_reverse_proxy( )" is a function mention with a space inside the parentheses.
    assert.equal(functionNear('rules from https://g/ by calling the init_reverse_proxy( ) function', 11, 10), 'init_reverse_proxy');
    // Valtrus v. Google, Dkt 1-7: a reference patent cited in full far away, the asserted patent as the shorthand next to the link.
    const decl = "See, e.g., U.S. Patent No. 4,503,495. " + 'x'.repeat(300) + " the invention of the '809 Patent. See https://g/";
    assert.equal(patentNear(decl, decl.indexOf('https://g/')), "'809", 'nearest wins over fullest');
  });
  it('flatten joins hyphenated wraps and page breaks so windows span them', () => {
    assert.equal(flatten('a self-\nmigrating thread\n\n   next'), 'a self-migrating thread next');
  });
  it('docDomains counts the non-repository sites: a documentation chart shows up as kubernetes.io', () => {
    const t = 'https://kubernetes.io/docs/a https://kubernetes.io/docs/b (https://kubernetes.io/docs/c) https://github.com/x/y https://docs.databricks.com/en/spark/index.html.';
    assert.deepEqual(docDomains(t), [{ domain: 'kubernetes.io', n: 3 }, { domain: 'docs.databricks.com', n: 1 }]);
  });
  it('summarizeText: best granularity across citations, the distinct repositories, and a "none" for a documentation-only chart', () => {
    const s = summarizeText(`${UNISWAP} and https://github.com/Uniswap/v2-core/ and https://github.com/huggingface/text-generation-inference/tree/main/router`);
    assert.equal(s.best, 'function');
    assert.deepEqual(s.repos, ['Uniswap/v2-core', 'huggingface/text-generation-inference']);
    assert.equal(summarizeText('see https://kubernetes.io/docs/concepts/ only').best, 'none');
  });
});

describe('the catalog', () => {
  const docket = { caseName: 'Bprotocol Foundation v. Universal Navigation Inc.', court: 'S.D.N.Y.', court_id: 'nysd', docketNumber: '1:25-cv-04214', docket_id: 1, dateFiled: '2025-05-20', suitNature: '830 Patent', docket_absolute_url: '/docket/1/x/' };
  const doc = (id, n, att, filepath) => ({ id, document_number: n, attachment_number: att, description: 'AMENDED COMPLAINT', page_count: 42, is_available: true, filepath_local: filepath, absolute_url: `/docket/1/${n}/x/` });
  it('a row carries the docket, the document, the URLs and the summary; a row without text has best null', () => {
    const r = catalogRow(docket, doc(47, '47', null, 'recap/a.pdf'), summarizeText(UNISWAP), 'chart-github');
    assert.equal(r.best, 'function'); assert.equal(r.pdfUrl, 'https://storage.courtlistener.com/recap/a.pdf'); assert.deepEqual(r.shapes, ['chart-github']);
    assert.equal(r.citations[0].at, undefined, 'positions are not persisted');
    assert.equal(catalogRow(docket, doc(48, '48', 2, null), null, 'x').best, null);
  });
  it('renderCatalog lists file-level or finer rows finest first with a distribution, and counts the coarser ones', () => {
    const rows = [
      catalogRow(docket, doc(47, '47', null, 'recap/a.pdf'), summarizeText(UNISWAP), 'chart-github'),
      catalogRow({ ...docket, caseName: 'FriendliAI Inc. v. Hugging Face, Inc.', dateFiled: '2023-07-28' }, doc(26, '26', 2, 'recap/b.pdf'), summarizeText('https://github.com/huggingface/text-generation-inference/tree/main/router'), 'blob-infringement'),
      catalogRow({ ...docket, caseName: 'IV v. BNY Mellon', dateFiled: '2025-05-08' }, doc(10, '10', 10, 'recap/c.pdf'), summarizeText('https://kubernetes.io/docs/a'), 'chart-github'),
      catalogRow({ ...docket, caseName: 'Line Co v. Code Inc', dateFiled: '2026-01-01' }, doc(3, '3', null, 'recap/d.pdf'), summarizeText('https://github.com/o/r/blob/v1/src/a.go#L10-L12'), 'blob-infringement'),
    ];
    const md = renderCatalog(rows, { generatedAt: '2026-10-20' });
    assert.match(md, /\| line \| 1 \|[\s\S]*\| function \| 1 \|[\s\S]*\| directory \| 1 \|[\s\S]*\| none \| 1 \|/);
    assert.match(md, /File-level or finer \(2\)/);
    const lineRow = md.indexOf('Line Co v. Code Inc'), fnRow = md.indexOf('Bprotocol Foundation');
    assert.ok(lineRow > 0 && fnRow > lineRow, 'line-level before function-level');
    assert.match(md, /\| mint \| 11,322,049 \| 1 \| 0 \| \[pdf\]\(https:\/\/storage\.courtlistener\.com\/recap\/a\.pdf\) \|/);
    assert.match(md, /Coarser \(2\)/);
    assert.ok(!md.includes('IV v. BNY Mellon'), 'a documentation-only chart is counted, not listed');
  });
  it('replaceSection swaps the generated block between the markers and refuses a page without them', () => {
    const page = `# Title\n\nprose\n\n${CATALOG_START}\nold\n${CATALOG_END}\n\nmore prose\n`;
    const out = replaceSection(page, 'NEW');
    assert.ok(out.includes(`${CATALOG_START}\nNEW\n${CATALOG_END}`) && out.includes('more prose') && !out.includes('old'));
    assert.throws(() => replaceSection('no markers', 'x'), /catalog markers/);
  });
  it('the query shapes carry the three sized on 2026-10-20, and the granularity ranks order finest first', () => {
    for (const k of ['chart-github', 'blob-infringement', 'contentions-blob']) assert.ok(QUERY_SHAPES.some((s) => s.key === k), k);
    assert.ok(GRANULARITY_RANK.line > GRANULARITY_RANK.function && GRANULARITY_RANK.function > GRANULARITY_RANK.file && GRANULARITY_RANK.file > GRANULARITY_RANK.document);
    const o = parseArgs(['--out', 'x', '--shapes', 'a,b', '--max-dockets', '7', '--no-download', '--rescore', '--cites', 'c.md']);
    assert.deepEqual([o.out, o.shapes, o.maxDockets, o.download, o.rescore, o.cites], ['x', ['a', 'b'], 7, false, true, 'c.md']);
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  });
});

describe('code quoted by name, with no link', () => {
  // Read out of the first run's texts on 2026-10-20, where a grep for empty parentheses found them:
  // R2 v. Databricks Dkt 149-2 pastes Spark source into a summary-judgment exhibit; Malikie v. ViaBTC
  // Dkt 1-7 and v. Foris Dkt 1-5 name secp256k1 functions and files; Uniloc v. Google Dkt 157-1
  // quotes an openh264 comment.
  const SPARK = '        if (conf.usePartitionEvaluator) {\n          left.execute().zipPartitionsWithEvaluator(right.execute(), evaluatorFactory)\n        } else {';
  const MALIKIE = 'For example, file secp256k1_recovery.h in the Bitcoin core comprises secp256k1_ecdsa_recoverable_signature.\n'
    + 'File main_impl.h implements secp256k1_ecdsa_sign_recoverable(), invoking secp256k1_ecdsa_sign_inner().\n'
    + 'For example, function secp256k1_ecdsa_recoverable_signature_save() is called from file main_impl.h. '
    + 'This meets claim 1 of U.S. Patent No. 8,520,842.';
  const OPENH264 = '53     /* profile_idc, constrained_setx_flag and level_idc is set by VerifyProfile(), probably';
  // A two-column chart as pdftotext -layout renders it: the row label at the line start, the
  // limitation and the evidence interleaved, an inline cross-reference that is not a row label.
  const CHART = '1[b]   generating, for use with said digital signature, an indicator   ViaBTC generated an indicator\n'
    + '       to identify which value\n\n'
    + '       For example, function secp256k1_ecdsa_recoverable_signature_save() is called from file main_impl.h.\n'
    + '       See claim 1[pre], supra.\n'
    + '1[c]   wherein the value is recovered\n'
    + '       File main_impl.h implements secp256k1_ecdsa_sign_recoverable(), invoking secp256k1_ecdsa_sign_inner().\n';
  it('reads a pasted Spark line, the secp256k1 sentences with their files, and a C comment', () => {
    assert.deepEqual(codeMentions(SPARK).functions.map((f) => f.name), ['left.execute', 'zipPartitionsWithEvaluator']);
    const m = codeMentions(MALIKIE);
    assert.deepEqual(m.functions.map((f) => f.name).sort(), ['secp256k1_ecdsa_recoverable_signature_save', 'secp256k1_ecdsa_sign_inner', 'secp256k1_ecdsa_sign_recoverable']);
    assert.deepEqual(m.files, [{ name: 'main_impl.h', n: 2, label: null }, { name: 'secp256k1_recovery.h', n: 1, label: null }]);
    assert.equal(m.functionCount, 3); assert.equal(m.patent, '8,520,842'); assert.equal(m.claim, '1', 'no row label: the nearest claim mention');
    assert.deepEqual(codeMentions(OPENH264).functions, [{ name: 'VerifyProfile', n: 1, label: null }]);
  });
  it('what is not code: prose parentheses, product names, a garbled page, a wiki URL; what is: a dotted call, a plain name with empty parentheses', () => {
    const prose = 'Uniswap Labs, LLC (the "Company") asserts the Patent(s) and claim(s) against the RaDaR(R) test and GelScann(1.0); '
      + 'a garbled page reads A9(x) and _(y); see https://en.bitcoin.it/wiki/Satoshi_(unit) and the function to() the pool.';
    assert.deepEqual(codeMentions(prose).functions, []);
    const code = 'Spark documentation states that "RDD.checkpoint()" marks the RDD; val nums = spark.range(5).withColumn("random", rand()); then mint() and wait( ) and secp256k1_scalar_mul(r, s).';
    assert.deepEqual(codeMentions(code).functions.map((f) => f.name), ['RDD.checkpoint', 'spark.range', 'withColumn', 'mint', 'wait', 'secp256k1_scalar_mul']);
    assert.equal(codeShapedCall('Patent', 's'), false); assert.equal(codeShapedCall('wait', ' '), true); assert.equal(codeShapedCall('to', ''), false);
    // Oracle v. Google Dkt 1465-5 and ThroughPuter v. Microsoft Dkt 92-40: package names (even ones ending in .go or .mm) and wrapped ".com" hosts are not files.
    const files = 'at 3 p.m. in Exhibit 10.c, IX.1.c and C.cc; see main_impl.h, OMX_Video.h and SortMergeJoinExec.scala, not https://github.com/moby/moby/blob/master/daemon/zfs.go; '
      + 'nor org.omg.stub.java, www.bittware.c, javax.m, gov.uscourts.c, com.gau.go or com.tencent.mm; but jquery.min.js and key.cpp';
    assert.deepEqual(codeMentions(files).files.map((f) => f.name), ['main_impl.h', 'OMX_Video.h', 'SortMergeJoinExec.scala', 'jquery.min.js', 'key.cpp']);
  });
  it('the patent falls back to the document\'s most-cited number when none is near the lead mention; a shorthand counts toward its full number', () => {
    assert.deepEqual(patentsIn("the '610 patent, U.S. Patent No. 8,190,610, the 8,190,610 patent, Patent No. 7,000,001, over 4,503,495 lines"), [{ number: '8,190,610', n: 3 }, { number: '7,000,001', n: 1 }]);
    // R2 v. Databricks Dkt 149-2: the pasted Spark listing sits pages from the nearest "Patent No."
    const far = `U.S. Patent No. 8,190,610, claim 1.\n${' '.repeat(3000)}left.execute()`;
    assert.equal(codeMentions(far).patent, '8,190,610');
    assert.deepEqual(codeMentions(far).patents, [{ number: '8,190,610', n: 1 }]);
    assert.equal(codeMentions("the '610 patent reads on mint() as U.S. Patent No. 8,190,610 says").patent, '8,190,610');
    assert.equal(codeMentions("the '610 patent reads on mint()").patent, "'610", 'a shorthand with no full number stays a shorthand');
    assert.equal(codeMentions('no patent here, just mint()').patent, null);
  });
  it('each name is placed under the chart row it sits in, every occurrence; an inline "see claim 1[pre]" is not a row', () => {
    const m = codeMentions(CHART);
    assert.deepEqual(m.rows.map((r) => [r.label, r.claim, r.functions, r.files]), [
      ['1[b]', '1', ['secp256k1_ecdsa_recoverable_signature_save'], ['main_impl.h']],
      ['1[c]', '1', ['secp256k1_ecdsa_sign_recoverable', 'secp256k1_ecdsa_sign_inner'], ['main_impl.h']],
    ]);
    // The fixture has no claim column of its own, so the row's limitation is the head of its text.
    assert.equal(m.rows[0].source, 'head');
    assert.ok(m.rows[0].limitation.startsWith('generating, for use with said digital signature, an indicator'), m.rows[0].limitation);
    assert.equal(m.claim, '1', 'the claim comes from the lead mention\'s row label');
    assert.equal(m.functions.find((f) => f.name === 'secp256k1_ecdsa_sign_inner').label, '1[c]');
    assert.equal(m.layout, 'chart');
  });
  it('row labels in their forms; a "Claim N" line is a row only when no element row is open', () => {
    assert.deepEqual([parseLabel('1[a] partitioning').label, parseLabel('1 (b)').label, parseLabel('[1a]').label, parseLabel('1[pre]').label, parseLabel('1(a)(i)').label], ['1[a]', '1[b]', '1[a]', '1[pre]', '1[a(i)]']);
    assert.deepEqual([parseLabel('Element 1', '3').label, parseLabel('Limitation 1[c]').label, parseLabel('1.2 wherein the').label, parseLabel('[d]', '2').label, parseLabel('Claim 16').kind], ['3[1]', '1[c]', '1.2', '2[d]', 'claim']);
    assert.equal(parseLabel('[d]'), null, 'a bare element with no claim in context is nothing');
    assert.equal(parseLabel('17. The Accused Products'), null, 'a numbered paragraph is not a row');
    assert.equal(parseLabel('Claim 1[a]'), null, '"Claim 1[a]" is prose, not the Claim N header form');
    assert.equal(parseLabel('  1[a]').len, 6, 'len covers the leading spaces');
  });
  it('a two-column chart: the claim column is the slice left of the page\'s dominant gap, and the limitation is read from it', () => {
    // Malikie v. ViaBTC Dkt 1-7, page 28, as pdftotext -layout writes it: a narrow claim column that wraps.
    const TWOCOL = [
      'Claim No.          Case 7:26-cv-00372 Document 1-7 Filed 09/09/26 Page 28 of 47',
      '                   Exemplary Evidence of Infringement',
      '',
      '1[a] by operation  ViaBTC, through the Accused Instrumentalities, generated a digital signature.',
      'of a               For example, function secp256k1_ecdsa_sign_recoverable() is called from file main_impl.h.',
      'cryptographic      See, e.g.:',
      'module             Source: bitcoin/src/secp256k1/src/secp256k1.c',
      '',
      '1[b] generating    ViaBTC generated an indicator by invoking secp256k1_ecdsa_sign_inner().',
      'an indicator       See claim 1[pre], supra.',
    ].join('\n');
    assert.equal(columnBoundary(TWOCOL.split('\n')), 19);
    assert.equal(columnBoundary(['one column', 'of plain prose', 'with no gaps at all']), null);
    const m = codeMentions(TWOCOL);
    assert.deepEqual(m.rows.map((r) => [r.label, r.source, r.limitation, r.functions, r.files]), [
      ['1[a]', 'left', 'by operation of a cryptographic module', ['secp256k1_ecdsa_sign_recoverable'], ['main_impl.h']],
      ['1[b]', 'left', 'generating an indicator', ['secp256k1_ecdsa_sign_inner'], []],
    ]);
    assert.equal(m.layout, 'chart');
  });
  it('a claim-text page gives each label its limitation verbatim; the chart rows that follow reuse it or carry their own claim column', () => {
    // R2 v. Databricks Dkt 149-2: page 15 lists the claim with its labels, the rows come after, across a page break.
    const CLAIMPAGE = [
      'Claim 1                     Case 4:23-cv-01147-ALM Document 149-2 Filed 05/08/25 Page 15 of 156 PageID #:',
      '',
      '1[pre]  A method of processing data of a data set over a distributed system, wherein the data set comprises a plurality of data groups,',
      '        the method comprising:',
      '',
      '1[a]    partitioning the data of each one of the data groups into a plurality of data partitions that each have a plurality of key-value pairs',
      '        and providing each data partition to a selected one of a plurality of mapping functions,',
      '',
      '1[b]    wherein the data of a first data group has a different schema than the data of a second data group,',
      '\f',
      'Claim 1                     Case 4:23-cv-01147-ALM Document 149-2 Filed 05/08/25 Page 16 of 156 PageID #:',
      '1[a] partitioning the data of each one of    In another example, ZippedPartitionsRDD.scala reflects that RDDs are provided to mapping',
      'the data groups into a plurality of data     functions; see rdds.map(_.partitions) in ZippedPartitionsRDD.scala.',
      'partitions                                   The partitioning is user-configurable.',
    ].join('\n');
    const m = codeMentions(CLAIMPAGE);
    assert.ok(m.limitations['1[pre]'].startsWith('A method of processing data of a data set') && m.limitations['1[pre]'].endsWith('the method comprising:'), m.limitations['1[pre]']);
    assert.ok(m.limitations['1[b]'].startsWith('wherein the data of a first data group'), 'a label with no names still gives its limitation');
    assert.deepEqual(m.rows.map((r) => [r.label, r.source, r.limitation, r.functions, r.files]), [
      ['1[a]', 'left', 'partitioning the data of each one of the data groups into a plurality of data partitions', ['rdds.map'], ['ZippedPartitionsRDD.scala']],
    ]);
    assert.ok(m.limitations['1[a]'].startsWith('partitioning the data of each one of the data groups into a plurality of data partitions that each have'), 'the claim page wins for the limitation map');
    assert.equal(m.claim, '1');
    const walk = chartRows(CLAIMPAGE);
    assert.deepEqual(walk.rows.map((r) => r.label), ['1[pre]', '1[a]', '1[b]'], 'the "Claim 1 … Page 15 of 156" line is a page header, not a row');
    assert.equal(walk.pagesWithColumns, 2);
  });
  it('a narrative complaint: the unit is the numbered paragraph, with the nearest claim number and the claim language it quotes', () => {
    // VideoLabs v. Meta Dkt 1, paragraphs 204 to 206: the code name sits in the pleader's own sentence.
    const NARRATIVE = [
      '       204. Claim 1 of the \'980 patent requires "switching between a plurality of probability tables based on a result of a comparison".',
      '',
      '       205. To effect the table switching mandated by the H.264 standard, the CABAC decoder',
      'in the Accused Products computes index ctxIdx to access the table. Index ctxIdx is specified by the',
      'H.264 standard to be the sum of ctxIdxOffset and ctxIdxBlockCatOffset(ctxBlockCat) and variable ctxIdxInc.',
      '',
      '       206. The Accused Products also decode audio data; see the step of "decoding audio data according to an input format" as claimed.',
    ].join('\n');
    const paras = paragraphsOf(NARRATIVE);
    assert.deepEqual(paras.map((p) => p.n), [204, 205, 206]);
    const m = codeMentions(NARRATIVE);
    assert.deepEqual(m.rows, []);
    assert.deepEqual(m.paragraphs.map((p) => [p.n, p.claim, p.quote, p.functions]), [[205, '1', null, ['ctxIdxBlockCatOffset']]]);
    assert.equal(m.functions[0].label, '¶ 205');
    assert.equal(m.claim, '1', 'the claim comes from the lead mention\'s paragraph');
    assert.equal(layoutOf({ paragraphs: 12 }), 'narrative');
    assert.equal(layoutOf({ elementRows: 2 }), 'chart');
    assert.equal(layoutOf({ claimRows: 1, chartWords: true }), 'chart', 'a one-row-per-claim exhibit that says "Exemplary Evidence"');
    assert.equal(layoutOf({ functionCount: 30 }), 'listing');
    assert.equal(layoutOf({}), 'other');
    assert.deepEqual(paragraphsOf('1. First.\n2. Second:\n   1. A list inside\n   2. Another item\n3. Third.').map((p) => p.n), [1, 2, 3], 'a list inside a paragraph does not split it');
  });
  it('summarizeText carries the code pass; the renderer shows the count on file-level rows and lists a coarse-link document that quotes code; the cites listing walks the rows', () => {
    const docket = { caseName: 'Malikie Innovations Ltd. v. ViaBTC Technology Ltd.', court: 'W.D. Tex.', court_id: 'txwd', docketNumber: '7:26-cv-00372', docket_id: 2, dateFiled: '2026-09-09', suitNature: '830 Patent' };
    const doc = (id, n, att) => ({ id, document_number: n, attachment_number: att, description: 'Exhibit', page_count: 9, is_available: true, filepath_local: `recap/${id}.pdf` });
    const rows = [
      catalogRow(docket, doc(1, '1', 7), summarizeText(`${MALIKIE} https://github.com/bitcoin/bips/blob/master/bip-0137.mediawiki`), 'chart-github'),
      catalogRow(docket, doc(2, '1', null), summarizeText('see mint() and https://kubernetes.io/docs/a'), 'chart-github'),
      catalogRow(docket, doc(3, '47', null), summarizeText(UNISWAP), 'chart-github'),
      catalogRow({ ...docket, caseName: 'Chart Co v. Row Inc' }, doc(4, '12', 3), summarizeText(CHART), 'contentions-blob'),
    ];
    assert.equal(rows[0].best, 'document'); assert.equal(rows[0].code.functionCount, 3); assert.equal(rows[2].code.functionCount, 0);
    assert.equal(catalogRow(docket, doc(5, '5', null), null, 'x').code, null);
    assert.equal(CODE_QUOTED_MIN, 3);
    const md = renderCatalog(rows, { generatedAt: '2026-10-20' });
    assert.match(md, /Code quoted by name\*\* \(at least 3[^\n]*: 2 document\(s\), 2 without a file-level link/);
    assert.match(md, /Code quoted without a file link \(2\)/);
    assert.match(md, /\| 1-7 \| 2026-09-09 \| document \| other \| 3 \| `secp256k1_ecdsa_sign_recoverable`, `secp256k1_ecdsa_sign_inner`, `secp256k1_ecdsa_recoverable_signature_save` \| `main_impl\.h`, `secp256k1_recovery\.h` \| 8,520,842 \| 1 \|/);
    assert.match(md, /\| 12-3 \| 2026-09-09 \| none \| chart \| 3 \|/);
    assert.match(md, /\| mint \| 11,322,049 \| 1 \| 0 \| \[pdf\]/);
    const listed = md.split('Code quoted without a file link')[1].split('\n').filter((l) => /^\| (Malikie|Chart Co)/.test(l));
    assert.equal(listed.length, 2, 'one function in passing is counted, not listed');
    const cites = renderCites(rows, { generatedAt: '2026-10-20' });
    assert.match(cites, /from 4 document\(s\), 3 of which name a function or a source file/);
    assert.match(cites, /## Chart Co v. Row Inc\n\ntxwd 7:26-cv-00372, document 12-3, filed 2026-09-09, claim 1, \[pdf\]/);
    assert.match(cites, /named as code; layout: chart\./);
    assert.match(cites, /- \*\*1\[b\]\*\* \[head\] "generating, for use with said digital signature[^\n]*"\n  - functions: `secp256k1_ecdsa_recoverable_signature_save`\n  - files: `main_impl\.h`\n- \*\*1\[c\]\*\* \[head\] "wherein the value is recovered[^\n]*"\n  - functions: `secp256k1_ecdsa_sign_recoverable`, `secp256k1_ecdsa_sign_inner`\n  - files: `main_impl\.h`/);
    assert.match(cites, /## Malikie Innovations Ltd\. v\. ViaBTC Technology Ltd\.\n\ntxwd 7:26-cv-00372, document 1-7, filed 2026-09-09, patent 8,520,842, claim 1, \[pdf\][^\n]*\n\nRepository link \(document\): `bitcoin\/bips bip-0137\.mediawiki`/);
    assert.match(cites, /- \*\*no row or paragraph nearby\*\*\n  - functions: `secp256k1_ecdsa_sign_recoverable`, `secp256k1_ecdsa_sign_inner`, `secp256k1_ecdsa_recoverable_signature_save`\n  - files: `main_impl\.h` ×2, `secp256k1_recovery\.h`/);
    assert.ok(!cites.includes('document 47'), 'a document with no code by name is not listed');
  });
});

describe('the claim text, from the patent', () => {
  // Claims 1 and 2 of US 8,190,610 as patents.google.com serves them (fetched 2026-10-20), and the
  // rows of R2 v. Databricks Dkt 149-2 as the chart's claim column reads them: a page-header fragment
  // on 1[d], a claim-text page's text on 1[pre], the head of the evidence on 2[a].
  const C1 = 'A method of processing data of a data set over a distributed system, wherein the data set comprises a plurality of data groups, the method comprising: '
    + 'partitioning the data of each one of the data groups into a plurality of data partitions that each have a plurality of key-value pairs and providing each data partition to a selected one of a plurality of mapping functions that are each user-configurable to independently output a plurality of lists of values for each of a set of keys found in such map function\'s corresponding data partition to form corresponding intermediate data for that data group and identifiable to that data group, '
    + 'wherein the data of a first data group has a different schema than the data of a second data group and the data of the first data group is mapped differently than the data of the second data group so that different lists of values are output for the corresponding different intermediate data, wherein the different schema and corresponding different intermediate data have a key in common; '
    + 'and reducing the intermediate data for the data groups to at least one output data group, including processing the intermediate data for each data group in a manner that is defined to correspond to that data group, so as to result in a merging of the corresponding different intermediate data based on the key in common, wherein the mapping and reducing operations are performed by a distributed system.';
  const C2 = 'The method of claim 1 , wherein: the at least one output data group is a plurality of output data groups.';
  const PATENT = { source: 'patent', number: '8,190,610', title: 'x', claims: [{ n: 1, text: C1 }, { n: 2, text: C2 }] };
  it('alignToClaim finds the span of the claim the row quotes; preambleOf stops at the transition that opens the body', () => {
    const a = alignToClaim('wherein the mapping and reducing operations are performed by a distributed system. 7 15115 Claim Feature Evidence', C1);
    assert.equal(a.span, 'wherein the mapping and reducing operations are performed by a distributed system.');
    assert.ok(a.agreement >= 0.7 && a.agreement < 1, `the header fragment's words are not in the span: ${a.agreement}`);
    const b = alignToClaim('wherein the data of a first data group has a different schema than the data of a second data group and the data of the first data group is mapped differently than the data of the second data group so that different lists of values are output for the corresponding different intermediate data, wherein the different schema and corresponding different intermediate data have a key in common; and', C1);
    assert.ok(b.span.startsWith('wherein the data of a first data group') && b.span.endsWith('have a key in common;'), b.span);
    assert.equal(b.agreement, 1);
    assert.equal(preambleOf(C1), 'A method of processing data of a data set over a distributed system, wherein the data set comprises a plurality of data groups, the method comprising:');
    assert.equal(alignToClaim('', C1), null);
    assert.equal(claimClauses('a; b: c wherein d and wherein e').length, 5, '"and wherein" opens one clause, not two');
  });
  it('applyClaims: a row with claim-column text takes the aligned span and keeps the chart\'s text; a row without takes the whole claim; a "Claim N" row loses its stray column heading', () => {
    const code = { rows: [
      { label: '1[pre]', claim: '1', element: 'pre', limitation: 'A method of processing data of a data set over a distributed system, wherein the data set comprises a plurality of data groups, the method comprising:', source: 'claim-page', functions: ['a'], files: [] },
      { label: '1[d]', claim: '1', element: 'd', limitation: 'wherein the mapping and reducing operations are performed by a distributed system. 7 15115 Claim Feature Evidence', source: 'left', functions: ['b'], files: [] },
      { label: '2[a]', claim: '2', element: 'a', limitation: 'In another example, ZippedPartitionsRDD.scala reflects', source: 'head', functions: ['c'], files: [] },
      { label: '3[a]', claim: '3', element: 'a', limitation: 'some text of a claim the fixture lacks', source: 'left', functions: ['d'], files: [] },
      // Veritaseum v. Coinbase Dkt 1-3: a column heading's "The" fell into the claim column.
      { label: 'claim 1', claim: '1', element: null, limitation: 'A method of processing data of a The data set over a distributed system', source: 'left', functions: ['e'], files: [] },
    ], paragraphs: [{ n: 12, claim: '2', quote: null, functions: ['f'], files: [] }, { n: 13, claim: '9', quote: null, functions: ['g'], files: [] }], limitations: {} };
    applyClaims(code, PATENT);
    const by = Object.fromEntries(code.rows.map((r) => [r.label, r]));
    assert.equal(by['1[pre]'].source, 'patent'); assert.equal(by['1[pre]'].agreement, 1); assert.ok(by['1[pre]'].limitation.endsWith('the method comprising:'));
    assert.equal(by['1[d]'].source, 'patent'); assert.equal(by['1[d]'].limitation, 'wherein the mapping and reducing operations are performed by a distributed system.');
    assert.ok(by['1[d]'].chartText.endsWith('Claim Feature Evidence'), 'the chart\'s own text stays beside the patent\'s');
    assert.equal(by['2[a]'].source, 'patent-claim'); assert.equal(by['2[a]'].limitation, C2); assert.equal(by['2[a]'].chartText, undefined);
    assert.equal(by['3[a]'].source, 'left'); assert.equal(by['3[a]'].agreement, null, 'a claim the source lacks leaves the row as it was');
    assert.equal(by['claim 1'].source, 'patent'); assert.equal(by['claim 1'].limitation, C1); assert.ok(by['claim 1'].agreement >= 0.9);
    assert.equal(code.paragraphs[0].source, 'patent-claim'); assert.equal(code.paragraphs[0].limitation, C2); assert.equal(code.paragraphs[1].source, undefined);
    assert.equal(code.limitations['1[d]'], by['1[d]'].limitation); assert.equal(code.claimSource, 'patent'); assert.equal(code.claimsApplied, 5);
    assert.equal(applyClaims(code, null), code);
  });
  it('a footnote digit glued to a patent number, a curly apostrophe, and a shorthand resolved across the docket', () => {
    // Malikie v. Foundry Dkt 1-14 and 1-11: "U.S. Patent No. 8,666,0621", "8,806,1971".
    assert.deepEqual(patentsIn('Exhibit 14: U.S. Patent No. 8,666,0621 and the ’062 Patent again'), [{ number: '8,666,062', n: 2 }]);
    assert.equal(patentNear('the ’197 Patent reads on https://g/', 30), "'197");
    assert.deepEqual(shortPatentsIn("the ’062 Patent, the '062 patent and the '197 Patent, see U.S. Patent No. 8,806,197"), [{ short: "'062", n: 2 }]);
    const rows = [
      { docketId: 7, docId: 1, code: { patent: null, patentShort: [{ short: "'062", n: 2 }], patents: [] } },
      { docketId: 7, docId: 2, code: { patent: '7,110,538', patents: [{ number: '7,110,538', n: 3 }, { number: '8,666,062', n: 1 }] } },
      { docketId: 8, docId: 3, code: { patent: "'062", patents: [] } },
      // True Return v. MakerDAO Dkt 1-6 names no patent; the docket's memorandum names only 10,025,797.
      { docketId: 9, docId: 4, code: { patent: null, patentShort: [], patents: [] } },
      { docketId: 9, docId: 5, code: { patent: '10,025,797', patents: [{ number: '10,025,797', n: 20 }] } },
      { docketId: 10, docId: 6, code: { patent: null, patentShort: [], patents: [] } },
      { docketId: 10, docId: 7, code: { patent: '1,000,001', patents: [{ number: '1,000,001', n: 1 }, { number: '1,000,002', n: 1 }] } },
    ];
    assert.equal(resolveAcrossDocket(rows), 2);
    assert.equal(rows[0].code.patent, '8,666,062'); assert.equal(rows[0].code.patentFrom, 'docket');
    assert.equal(rows[2].code.patent, "'062", 'another docket does not resolve it');
    assert.equal(rows[3].code.patent, '10,025,797'); assert.equal(rows[3].code.patentFrom, 'docket-only');
    assert.equal(rows[5].code.patent, null, 'a docket naming two patents resolves nothing for a document naming none');
  });
  it('a claim the document reproduces serves where no patent resolves; a prayer for relief and a two-column patent page do not', () => {
    const DOC = [
      '       23. Claim 1 of the \'137 Patent recites:',
      '       1. A system for creating interactive television applications, the system comprising:',
      '       a template author system comprising: a display; a user interface; and',
      '       a processor coupled to the display and the user interface, the processor comprising:',
      '       a component for presenting a layout window on the display; and',
      '       a component for assigning one or more display elements to the layout window.',
      '       2. The system of claim 1, wherein the components are distributed across a network.',
      '',
      '       24. The Accused Products are systems for creating interactive television applications.',
      '',
      '                                     PRAYER FOR RELIEF',
      '       1. A judgment in favor of Plaintiff that Defendant has infringed the \'137 Patent;',
      '       2. A judgment and order requiring Defendant to pay Plaintiff its damages;',
    ].join('\n');
    const b = claimBlockOf(DOC);
    assert.deepEqual(b.claims.map((c) => c.n), [1, 2]);
    assert.ok(b.claims[0].text.startsWith('A system for creating interactive television applications, the system comprising:') && b.claims[0].text.endsWith('to the layout window.'), b.claims[0].text);
    assert.equal(b.source, 'document');
    assert.equal(claimBlockOf('       1. A judgment in favor of Plaintiff that Defendant has infringed;\n       2. A judgment and order requiring Defendant to pay;'), null);
    // ESW v. Roku Dkt 1-2 attaches the patent: its claims page is two columns of interleaved lines.
    assert.equal(claimBlockOf('   1. A method for providing an authoring environment for                 system can initiate the attribute change\ngenerating an attribute change, the method comprising:'), null);
    assert.equal(claimSourceFor({ patent: null }, DOC, 'nowhere').source, 'document');
    assert.equal(claimSourceFor({ patent: "'137" }, 'no claim here', 'nowhere'), null);
  });
  it('a paragraph quote is kept only when it reads like a claim and not like code', () => {
    assert.equal(claimShapedQuote('public class @ extends LogWrapperBase {'), false);
    assert.equal(claimShapedQuote('is defined within PrintWriter println() statements'), false);
    assert.equal(claimShapedQuote('a large tank or tub used to hold liquid'), false);
    assert.equal(claimShapedQuote('the step of receiving a request from a client device'), true);
    assert.equal(claimShapedQuote(null), false);
    const m = codeMentions('       12. The product calls initWidget() as described in "public class Widget extends Base {" and so on for the record.\n');
    assert.equal(m.paragraphs[0].quote, null);
  });
  it('renderCites shows the patent tag with its agreement, the chart\'s text beneath where it differs, and a paragraph\'s claim text', () => {
    const rows = [{ caseName: 'R2 Solutions LLC v. Databricks, Inc.', courtId: 'txed', docketNumber: '4:23-cv-01147', documentNumber: '149', attachmentNumber: 2, dateFiled: '2023-12-28', pdfUrl: null, citations: [],
      code: { layout: 'chart', functionCount: 2, fileCount: 0, functions: [{ name: 'a', n: 1, label: '1[d]' }, { name: 'f', n: 1, label: '¶ 12' }], files: [], patents: [{ number: '8,190,610', n: 4 }], patent: '8,190,610', claim: '1', claimSource: 'patent',
        rows: [{ label: '1[d]', claim: '1', element: 'd', limitation: 'wherein the mapping and reducing operations are performed by a distributed system.', chartText: 'wherein the mapping and reducing operations are performed by a distributed system. 7 15115 Claim Feature Evidence', source: 'patent', agreement: 0.73, functions: ['a'], files: [] }],
        paragraphs: [{ n: 12, claim: '2', quote: 'the at least one output data group', limitation: C2, source: 'patent-claim', functions: ['f'], files: [] }], limitations: {} } }];
    const md = renderCites(rows, { generatedAt: '2026-10-21' });
    assert.match(md, /patent 8,190,610, claim 1, claim text from the patent\./);
    assert.match(md, /- \*\*1\[d\]\*\* \[patent 0\.73\] "wherein the mapping and reducing operations are performed by a distributed system\."\n  - chart: "wherein the mapping[^\n]*Claim Feature Evidence"\n  - functions: `a`/);
    assert.match(md, /- \*\*¶ 12\*\* \(claim 2\) \[patent-claim\] "The method of claim 1 , wherein: the at least one output data group is a plurality of output data groups\."\n  - quotes: "the at least one output data group"\n  - functions: `f`/);
    assert.equal(parseArgs(['--out', 'x', '--fetch-claims']).fetchClaims, true);
  });
});
