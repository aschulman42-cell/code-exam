// #223: unit coverage for the air-gapped guard module. The live blocking of the
// real cloud call sites is verified manually (CLI + GUI with/without a key); here
// we cover the deterministic core: flag state, the assertLocalOnly gate, the key
// scrub, and the disclaimer's content.

import { test } from 'node:test';
import assert from 'node:assert';
import {
  setAirGapped, isAirGapped, allowConnected, assertLocalOnly, scrubApiKey,
  AIR_GAPPED_DISCLAIMER,
} from '../src/core/air-gapped.js';

test('setAirGapped / isAirGapped / allowConnected reflect the flag state', () => {
  setAirGapped(false);
  assert.strictEqual(isAirGapped(), false);
  setAirGapped(true);
  assert.strictEqual(isAirGapped(), true);
  assert.strictEqual(allowConnected(), false);
  setAirGapped(true, { allowConnected: true });
  assert.strictEqual(allowConnected(), true);
  setAirGapped(false); // reset
});

test('assertLocalOnly throws only when air-gapped, with a helpful message', () => {
  setAirGapped(false);
  assert.doesNotThrow(() => assertLocalOnly('claim-search'));
  setAirGapped(true);
  assert.throws(() => assertLocalOnly('AI Overview'),
    /air-gapped[\s\S]*AI Overview[\s\S]*--model/i);
  setAirGapped(false); // reset
});

test('scrubApiKey removes ANTHROPIC_API_KEY from the env', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-DO-NOT-USE';
  scrubApiKey();
  assert.strictEqual(process.env.ANTHROPIC_API_KEY, undefined);
});

test('the disclaimer names the key + the un-guaranteed surfaces', () => {
  assert.match(AIR_GAPPED_DISCLAIMER, /ANTHROPIC_API_KEY/);
  assert.match(AIR_GAPPED_DISCLAIMER, /network drive|cloud-synced|OneDrive/i);
  assert.match(AIR_GAPPED_DISCLAIMER, /AIR_GAPPED\.md/);
});
