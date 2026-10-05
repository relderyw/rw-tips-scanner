import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTopPayoutAssets } from '../lib/assetRanking.js';

const asset = (id, payout, overrides = {}) => ({
  id,
  name: id,
  payout,
  isOpen: true,
  analysisSupported: true,
  ...overrides,
});

test('top payout selection returns only open, supported assets with a positive real payout', () => {
  const selected = selectTopPayoutAssets([
    asset('lower', 85),
    asset('highest', 95),
    asset('closed', 99, { isOpen: false }),
    asset('unsupported', 98, { analysisSupported: false }),
    asset('missing-payout', null),
    asset('zero-payout', 0),
  ]);

  assert.deepEqual(selected.map(({ id }) => id), ['highest', 'lower']);
});

test('top payout selection is capped and sorts payout ties deterministically', () => {
  const selected = selectTopPayoutAssets([
    asset('C', 90),
    asset('B', 90),
    asset('A', 95),
  ], 2);

  assert.deepEqual(selected.map(({ id }) => id), ['A', 'B']);
  assert.deepEqual(selectTopPayoutAssets([asset('A', 95)], 0), []);
});
