/**
 * test_har.js - Tests for .har (DevTools network capture) expansion in
 * --build-index (#161).
 *
 * Covers: text entry extraction, base64 decoding, extension inference from
 * mimeType, query-string stripping, duplicate-URL dedupe (identical vs
 * differing content), missing-body counting, non-text skipping, non-http
 * scheme skipping, and malformed-HAR handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandArchive, createArchiveStats } from '../src/archive.js';

function harOf(entries) {
  return Buffer.from(JSON.stringify({
    log: { version: '1.2', creator: { name: 'test' }, entries },
  }));
}

function entry(url, mimeType, text, extra = {}) {
  return {
    request: { url },
    response: { content: { mimeType, text, ...extra } },
  };
}

function expand(buf, opts = {}) {
  const stats = createArchiveStats();
  const results = expandArchive(buf, {
    archiveName: 'capture.har',
    showProgress: false,
    stats,
    ...opts,
  });
  return { results, stats };
}

describe('HAR expansion', () => {
  it('extracts a JS response with the host-prefixed virtual path', () => {
    const { results } = expand(harOf([
      entry('https://example.com/static/app.js', 'application/javascript', 'function hi() {}'),
    ]));
    assert.equal(results.length, 1);
    assert.equal(results[0].virtualPath, 'capture.har!example.com/static/app.js');
    assert.equal(results[0].content, 'function hi() {}');
  });

  it('strips query strings and decodes base64 bodies', () => {
    const js = 'const x = 1;';
    const { results } = expand(harOf([
      entry('https://cdn.example.com/chunk.js?v=abc123', 'text/javascript',
            Buffer.from(js).toString('base64'), { encoding: 'base64' }),
    ]));
    assert.equal(results.length, 1);
    assert.equal(results[0].virtualPath, 'capture.har!cdn.example.com/chunk.js');
    assert.equal(results[0].content, js);
  });

  it('infers an extension from mimeType for bare paths; / becomes index.html', () => {
    const { results } = expand(harOf([
      entry('https://example.com/', 'text/html', '<html></html>'),
      entry('https://example.com/api/config', 'application/json', '{"a":1}'),
    ]));
    const paths = results.map(r => r.virtualPath).sort();
    assert.deepEqual(paths, [
      'capture.har!example.com/api/config.json',
      'capture.har!example.com/index.html',
    ]);
  });

  it('dedupes identical repeat captures; suffixes differing content', () => {
    const { results } = expand(harOf([
      entry('https://example.com/a.js', 'text/javascript', 'same'),
      entry('https://example.com/a.js', 'text/javascript', 'same'),
      entry('https://example.com/a.js', 'text/javascript', 'different'),
    ]));
    const paths = results.map(r => r.virtualPath).sort();
    assert.deepEqual(paths, [
      'capture.har!example.com/a.js',
      'capture.har!example.com/a_2.js',
    ]);
  });

  it('skips non-text mimeTypes and counts them as skippedBinary', () => {
    const { results, stats } = expand(harOf([
      entry('https://example.com/logo.png', 'image/png', 'AAAA', { encoding: 'base64' }),
      entry('https://example.com/font.woff2', 'font/woff2', 'AAAA', { encoding: 'base64' }),
      entry('https://example.com/a.js', 'text/javascript', 'ok'),
    ]));
    assert.equal(results.length, 1);
    assert.equal(stats.skippedBinary, 2);
  });

  it('skips entries with missing bodies and non-http(s) schemes without throwing', () => {
    const { results } = expand(harOf([
      { request: { url: 'https://example.com/missing.js' },
        response: { content: { mimeType: 'text/javascript' } } },   // no text
      entry('data:text/javascript;base64,QQ==', 'text/javascript', 'x'),
      entry('ws://example.com/socket', '', 'x'),
      entry('https://example.com/ok.js', 'text/javascript', 'ok'),
    ]));
    assert.equal(results.length, 1);
    assert.equal(results[0].virtualPath, 'capture.har!example.com/ok.js');
  });

  it('falls back to URL extension when mimeType is absent', () => {
    const { results } = expand(harOf([
      entry('https://example.com/styles.css', '', 'body {}'),
      entry('https://example.com/blob', '', 'opaque'),   // no mime, no ext -> skipped
    ]));
    assert.equal(results.length, 1);
    assert.equal(results[0].virtualPath, 'capture.har!example.com/styles.css');
  });

  it('honors a caller-provided extension set', () => {
    const { results } = expand(harOf([
      entry('https://example.com/a.js', 'text/javascript', 'js'),
      entry('https://example.com/a.css', 'text/css', 'css'),
    ]), { extensions: new Set(['.js']) });
    assert.equal(results.length, 1);
    assert.equal(results[0].virtualPath, 'capture.har!example.com/a.js');
  });

  it('replaces the port colon so file:line rendering stays unambiguous', () => {
    const { results } = expand(harOf([
      entry('http://localhost:3006/app.js', 'text/javascript', 'x'),
    ]));
    assert.equal(results[0].virtualPath, 'capture.har!localhost_3006/app.js');
  });

  it('reports malformed JSON and missing log.entries as errors, not crashes', () => {
    const bad = expand(Buffer.from('not json at all'));
    assert.equal(bad.results.length, 0);
    assert.equal(bad.stats.errors, 1);
    const notHar = expand(Buffer.from('{"some":"json"}'));
    assert.equal(notHar.results.length, 0);
    assert.equal(notHar.stats.errors, 1);
  });
});
