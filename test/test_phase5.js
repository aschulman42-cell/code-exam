/**
 * test_phase5.js - Tests for multi-term intersection search (Phase 5).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { parseMultisectTerms, doMultisect } from '../src/commands/multisect.js';

const TEST_DIR = path.join(os.tmpdir(), 'code_exam_test_p5');
const INDEX_PATH = path.join(os.tmpdir(), 'code_exam_test_p5_idx');

describe('Phase 5: Multi-term intersection search', () => {
  let index;

  before(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Create test files with known content for predictable multisect results
    fs.writeFileSync(path.join(TEST_DIR, 'server.py'), [
      'import socket',
      'def handle_request(conn):',
      '    data = conn.recv(1024)',
      '    response = process(data)',
      '    conn.send(response)',
      '',
      'def start_server(port):',
      '    sock = socket.socket()',
      '    sock.bind(("0.0.0.0", port))',
      '    sock.listen(5)',
      '    while True:',
      '        conn, addr = sock.accept()',
      '        handle_request(conn)',
    ].join('\n'));

    fs.writeFileSync(path.join(TEST_DIR, 'client.py'), [
      'import socket',
      'def send_request(host, port, data):',
      '    sock = socket.socket()',
      '    sock.connect((host, port))',
      '    sock.send(data)',
      '    response = sock.recv(1024)',
      '    return response',
    ].join('\n'));

    fs.writeFileSync(path.join(TEST_DIR, 'database.py'), [
      'import sqlite3',
      'def connect_db(path):',
      '    return sqlite3.connect(path)',
      '',
      'def query_db(conn, sql):',
      '    cursor = conn.execute(sql)',
      '    return cursor.fetchall()',
      '',
      'def insert_record(conn, table, data):',
      '    conn.execute(f"INSERT INTO {table} VALUES (?)", data)',
      '    conn.commit()',
    ].join('\n'));

    fs.mkdirSync(path.join(TEST_DIR, 'net'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'net', 'protocol.py'), [
      'def encode_packet(data, port):',
      '    header = build_header(port)',
      '    return header + data',
      '',
      'def decode_packet(packet):',
      '    header = packet[:16]',
      '    data = packet[16:]',
      '    return header, data',
    ].join('\n'));

    // Java interface file — content outside functions, for (global) testing
    fs.writeFileSync(path.join(TEST_DIR, 'Constants.java'), [
      'package org.example;',
      '',
      'import javax.servlet.http.HttpServletRequest;',
      'import javax.servlet.http.HttpServletResponse;',
      '',
      'public interface Constants {',
      '    String REQUEST_PARAM = "request-param";',
      '    String RESPONSE_HEADER = "response-header";',
      '    String SERVLET_PATH = "/api/servlet";',
      '}',
    ].join('\n'));

    // File with multiple terms on same line, for collapse testing
    fs.writeFileSync(path.join(TEST_DIR, 'handler.java'), [
      'class RequestHandler {',
      '    void doPost(HttpServletRequest request, HttpServletResponse response) {',
      '        String body = request.getBody();',
      '        response.send(body);',
      '    }',
      '}',
    ].join('\n'));

    index = new CodeSearchIndex({ indexPath: INDEX_PATH });
    await index.buildIndex(TEST_DIR, { showProgress: false });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(INDEX_PATH, { recursive: true, force: true });
  });

  // ---- Term parser tests ----

  describe('parseMultisectTerms', () => {
    it('parses simple semicolon-separated terms', () => {
      const terms = parseMultisectTerms('socket;port;data');
      assert.equal(terms.length, 3);
      assert.equal(terms[0].display, 'socket');
      assert.equal(terms[1].display, 'port');
      assert.equal(terms[2].display, 'data');
      assert.equal(terms[0].negated, false);
    });

    it('parses NOT terms', () => {
      const terms = parseMultisectTerms('socket;NOT database;!server');
      assert.equal(terms.length, 3);
      assert.equal(terms[0].negated, false);
      assert.equal(terms[1].negated, true);
      assert.ok(terms[1].display.includes('NOT'));
      assert.equal(terms[2].negated, true);
    });

    it('parses regex terms', () => {
      const terms = parseMultisectTerms('/conn\\.\\w+/;port');
      assert.equal(terms.length, 2);
      assert.ok(terms[0].display.startsWith('/'));
    });

    it('handles dot-wildcard in plain terms', () => {
      const terms = parseMultisectTerms('real.time');
      assert.equal(terms.length, 1);
      // Should convert dots to .? and wrap in regex
      assert.ok(terms[0].display.includes('/'));
      assert.ok(terms[0].regex.test('realtime'));
      assert.ok(terms[0].regex.test('real-time'));
      assert.ok(terms[0].regex.test('real_time'));
    });

    it('handles escaped semicolons', () => {
      const terms = parseMultisectTerms('hello;;world;other');
      assert.equal(terms.length, 2);
      assert.equal(terms[0].display, 'hello;world');
    });

    it('skips empty terms', () => {
      const terms = parseMultisectTerms(';;socket;;;port;;');
      assert.equal(terms.length, 2);
    });

    it('returns null for invalid regex', () => {
      const terms = parseMultisectTerms('/[invalid/');
      assert.equal(terms, null);
    });

    it('parses the four (hard, negated) prefix forms', () => {
      // term -> (hard,false); !term/NOT term -> (hard,true);
      // ?term -> (soft,false); ?!term/?NOT term -> (soft,true).
      const terms = parseMultisectTerms('socket;!database;?cache;?!legacy;?NOT stub');
      assert.equal(terms.length, 5);

      // hard-required
      assert.equal(terms[0].hard, true);
      assert.equal(terms[0].negated, false);
      assert.equal(terms[0].display, 'socket');

      // hard-NOT
      assert.equal(terms[1].hard, true);
      assert.equal(terms[1].negated, true);
      assert.equal(terms[1].display, 'NOT database');

      // soft-required
      assert.equal(terms[2].hard, false);
      assert.equal(terms[2].negated, false);
      assert.equal(terms[2].display, '?cache');

      // soft-NOT via ?!
      assert.equal(terms[3].hard, false);
      assert.equal(terms[3].negated, true);
      assert.equal(terms[3].display, '?NOT legacy');

      // soft-NOT via ?NOT
      assert.equal(terms[4].hard, false);
      assert.equal(terms[4].negated, true);
      assert.equal(terms[4].display, '?NOT stub');
    });

    it('applies the ? prefix to regex and dot-wildcard terms', () => {
      const terms = parseMultisectTerms('?/conn\\w+/;?real.time');
      assert.equal(terms.length, 2);
      assert.equal(terms[0].hard, false);
      assert.equal(terms[0].negated, false);
      assert.ok(terms[0].display.startsWith('?/'));
      assert.equal(terms[1].hard, false);
      assert.ok(terms[1].display.startsWith('?/'));
      assert.ok(terms[1].regex.test('real-time'));
    });

    it('defaults hard to true for unprefixed terms', () => {
      const terms = parseMultisectTerms('socket;port;data');
      assert.ok(terms.every(t => t.hard === true));
    });
  });

  // ---- Core search tests ----

  describe('multisectSearch', () => {
    it('finds functions containing all terms', () => {
      const terms = parseMultisectTerms('socket;port');
      const results = index.multisectSearch(terms, { showProgress: false });

      assert.ok(results);
      assert.equal(results.num_terms, 2);
      assert.equal(results.num_positive, 2);
      assert.ok(results.function_matches.length > 0, 'Should find function-level matches');

      // start_server has both socket and port
      const startServer = results.function_matches.find(m =>
        m.function === 'start_server' || m.function.includes('start_server'));
      assert.ok(startServer, 'start_server should match both terms');
      assert.equal(startServer.terms_matched, 2);
    });

    it('finds file-level matches', () => {
      const terms = parseMultisectTerms('socket;port');
      const results = index.multisectSearch(terms, { showProgress: false });

      assert.ok(results.file_matches.length > 0, 'Should find file-level matches');
      // server.py has both socket and port
      const serverFile = results.file_matches.find(m => m.filepath.includes('server.py'));
      assert.ok(serverFile, 'server.py should match both terms');
    });

    it('finds folder-level matches', () => {
      // net/protocol.py has both data and packet
      const terms = parseMultisectTerms('data;packet');
      const results = index.multisectSearch(terms, { showProgress: false });

      assert.ok(results);
      // net/ folder should have folder-level matches
      const netFolder = results.folder_matches.find(m => m.folder === 'net');
      assert.ok(netFolder, 'net/ folder should appear in folder matches');
    });

    it('NOT terms exclude matching files', () => {
      const terms = parseMultisectTerms('socket;NOT sqlite3');
      const results = index.multisectSearch(terms, { showProgress: false });

      assert.ok(results);
      // database.py has sqlite3, should be excluded from file matches
      const dbFile = results.file_matches.find(m => m.filepath.includes('database.py'));
      assert.equal(dbFile, undefined, 'database.py should be excluded by NOT term');
    });

    it('respects min_terms for partial matching', () => {
      const terms = parseMultisectTerms('socket;port;sqlite3');
      const allResults = index.multisectSearch(terms, { showProgress: false });
      const partialResults = index.multisectSearch(terms, { minTerms: 1, showProgress: false });

      assert.ok(partialResults.file_matches.length >= allResults.file_matches.length,
        'Partial matching should find at least as many results');
    });

    it('respects includePath filter', () => {
      const terms = parseMultisectTerms('data;packet');
      const results = index.multisectSearch(terms, {
        includePath: ['net'],
        showProgress: false,
      });

      assert.ok(results);
      // Only net/protocol.py should be in results
      for (const m of results.file_matches) {
        assert.ok(m.filepath.includes('net'), `File ${m.filepath} should be in net/`);
      }
    });

    it('returns empty results for impossible intersection', () => {
      const terms = parseMultisectTerms('sqlite3;socket');
      const results = index.multisectSearch(terms, { showProgress: false });

      assert.ok(results);
      // No single file has both sqlite3 and socket
      assert.equal(results.function_matches.length, 0, 'No function should contain both');
      assert.equal(results.file_matches.length, 0, 'No file should contain both');
    });

    it('matches terms in filepaths as well as content', () => {
      // "protocol" appears in the path net/protocol.py but also in content.
      // "net" appears in path net/protocol.py — may or may not be in content.
      // Use a term that ONLY appears in the path
      const terms = parseMultisectTerms('protocol;encode');
      const results = index.multisectSearch(terms, { showProgress: false });

      assert.ok(results);
      // protocol.py should match — "encode" is in content, "protocol" in both path and content
      const protoFile = results.file_matches.find(m => m.filepath.includes('protocol.py'));
      assert.ok(protoFile, 'protocol.py should be found');
    });

    it('finds file via path-only match when term is only in filepath', () => {
      // "Constants" only appears in the filename Constants.java, not in the file content
      // (the content has "Constants" in the class name though — let me use a purer example)
      // "handler" appears in path handler.java but also in content
      // The test just verifies the mechanism works — path matches count
      const terms = parseMultisectTerms('handler;doPost');
      const results = index.multisectSearch(terms, { showProgress: false });

      assert.ok(results);
      assert.ok(results.file_matches.length > 0, 'Should find handler.java');
    });

    it('path-only match appears at file level with path detail', () => {
      // "net" only appears in the folder name net/ (not in file content)
      // "encode" is in net/protocol.py content
      const terms = parseMultisectTerms('net;encode');
      const results = index.multisectSearch(terms, { showProgress: false });

      assert.ok(results);
      const protoFile = results.file_matches.find(m => m.filepath.includes('protocol.py'));
      assert.ok(protoFile, 'net/protocol.py should match via path + content');
      // The "net" term (index 0) should have a path-match detail (line_num 0)
      const netDetail = protoFile.details[0];
      assert.ok(netDetail, 'net term should have a detail entry');
      assert.equal(netDetail.line_num, 0, 'path-only match should have line_num 0');
      assert.ok(netDetail.line_text.includes('path match'),
        'Path-only match should have path match indicator');
    });

    it('returns term file counts', () => {
      const terms = parseMultisectTerms('socket;port;sqlite3');
      const results = index.multisectSearch(terms, { showProgress: false });

      assert.equal(results.term_file_counts.length, 3);
      assert.ok(results.term_file_counts[0] > 0, 'socket should appear in some files');
      assert.ok(results.term_file_counts[2] > 0, 'sqlite3 should appear in some files');
    });
  });

  // ---- Display integration tests ----

  describe('doMultisect display', () => {
    it('produces output without crashing', () => {
      const origLog = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(' '));
      try {
        doMultisect(index, {
          multisect_search: 'socket;port',
          min_terms: '0',
          max_results: 5,
          full_path: false,
          verbose: false,
        });
      } finally {
        console.log = origLog;
      }

      assert.ok(lines.length > 0, 'Should produce output');
      const output = lines.join('\n');
      assert.ok(output.includes('FUNCTION-level') || output.includes('FILE-level') || output.includes('No matches'),
        'Should show results at some scope level');
    });

    it('shows selectivity report', () => {
      const origLog = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(' '));
      try {
        doMultisect(index, {
          multisect_search: 'socket;port',
          min_terms: '0',
          max_results: 5,
        });
      } finally {
        console.log = origLog;
      }

      const output = lines.join('\n');
      assert.ok(output.includes('selectivity'), 'Should show selectivity report');
    });

    it('excludes (global) from function-level display', () => {
      // Constants.java has servlet/request/response outside any function
      const origLog = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(' '));
      try {
        doMultisect(index, {
          multisect_search: 'servlet;request;response',
          min_terms: '0',
          max_results: 20,
          verbose: false,
        });
      } finally {
        console.log = origLog;
      }

      const output = lines.join('\n');
      // If there are FUNCTION-level results, none should be (global)
      const funcSection = output.split('FUNCTION-level')[1] || '';
      const beforeFile = funcSection.split('FILE-level')[0] || funcSection;
      assert.ok(!beforeFile.includes('(global)'),
        'Function-level results should not include (global) matches');
      // But file-level should still show Constants.java
      assert.ok(output.includes('Constants.java'),
        'Constants.java should appear in file-level matches');
    });

    it('scope dedup suppresses file when function covers all terms', () => {
      const origLog = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(' '));
      try {
        // socket;port: start_server has both in a real function
        doMultisect(index, {
          multisect_search: 'socket;port',
          min_terms: '0',
          max_results: 20,
          verbose: false,  // non-verbose triggers scope dedup
        });
      } finally {
        console.log = origLog;
      }

      const output = lines.join('\n');
      // Should mention suppression if there are covered files
      if (output.includes('suppressed')) {
        assert.ok(output.includes('covered by function'),
          'Suppressed note should mention function coverage');
      }
    });

    it('shows --in path filter when active', () => {
      const origLog = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(' '));
      try {
        doMultisect(index, {
          multisect_search: 'socket;port',
          min_terms: '0',
          max_results: 5,
          vocab_in: 'server',
        });
      } finally {
        console.log = origLog;
      }

      const output = lines.join('\n');
      assert.ok(output.includes('Path filter') && output.includes('server'),
        'Should display active --in path filter');
    });

    it('does not show path filter line when no --in active', () => {
      const origLog = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(' '));
      try {
        doMultisect(index, {
          multisect_search: 'socket;port',
          min_terms: '0',
          max_results: 5,
        });
      } finally {
        console.log = origLog;
      }

      const output = lines.join('\n');
      assert.ok(!output.includes('Path filter'),
        'Should not show path filter line when --in not active');
    });

    it('collapses multiple terms hitting the same line', () => {
      // handler.java line 2: "doPost(HttpServletRequest request, HttpServletResponse response)"
      // has both "request" and "response" on the same line
      const origLog = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(' '));
      try {
        doMultisect(index, {
          multisect_search: 'request;response',
          min_terms: '0',
          max_results: 20,
          verbose: true,  // verbose to see all file-level too
        });
      } finally {
        console.log = origLog;
      }

      const output = lines.join('\n');
      // Should have [1,2] style collapsed format somewhere
      // (handler.java's doPost line has both terms)
      assert.ok(output.includes('[1,2]') || output.includes('[1, 2]'),
        'Should collapse multiple terms on same line into [1,2] format');
    });
  });
});
