/**
 * test_path_prefix.js — commonPathPrefix (path-prefix peeling for the
 * accordions / Overview). Strict common prefix when all paths share one;
 * dominant prefix (with outlier tolerance) for the "all but a few" case.
 *
 * Run: node --test test/test_path_prefix.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commonPathPrefix } from '../public/dom-utils.js';

const BASE = 'Windows-classic-samples-main.zip!Windows-classic-samples-main/Samples/Win7Samples/';

describe('commonPathPrefix', () => {
  it('peels the strict common prefix when all paths share one (covers all)', () => {
    const r = commonPathPrefix([
      BASE + 'netds/rpc/asyncrpc/AsyncRPCc.c',
      BASE + 'netds/rpc/cluuid/ClUuidc.c',
      BASE + 'winbase/service/Client.c',
    ]);
    assert.equal(r.prefix, BASE);
    assert.equal(r.covered, r.total);
    assert.equal(r.total, 3);
  });

  it('tolerates an outlier — dominant prefix covers most, not all', () => {
    const r = commonPathPrefix([
      BASE + 'netds/rpc/asyncrpc/AsyncRPCc.c',
      BASE + 'netds/rpc/cluuid/ClUuidc.c',
      BASE + 'winbase/service/Client.c',
      'SomeOther/repo/foo.c',
    ]);
    assert.equal(r.prefix, BASE, 'dominant prefix is still the shared base');
    assert.ok(r.covered < r.total, 'the outlier is not covered → "unless otherwise indicated"');
    assert.equal(r.covered, 3);
  });

  it('returns no prefix when the common part is too short to be worth peeling', () => {
    assert.equal(commonPathPrefix(['src/a.js', 'src/b.js']).prefix, '');
  });

  it('returns no prefix for fewer than two paths', () => {
    assert.equal(commonPathPrefix(['a/b/c.js']).prefix, '');
    assert.equal(commonPathPrefix([]).prefix, '');
  });

  it('normalizes backslashes', () => {
    const r = commonPathPrefix([
      'C:\\proj\\src\\modules\\alpha\\one.js',
      'C:\\proj\\src\\modules\\beta\\two.js',
    ]);
    assert.ok(r.prefix.startsWith('C:/proj/src/modules/'), `got ${r.prefix}`);
    assert.equal(r.covered, 2);
  });
});
