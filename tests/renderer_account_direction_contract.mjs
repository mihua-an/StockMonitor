// Long/short classification has one contract: every account aggregate uses isLongDirection /
// isShortDirection, and a direction outside "多"/"空" is reported (console.error -> error.log) instead
// of silently falling out of the totals.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLongDirection, isShortDirection } from '../ui/renderer/js/features/account/trade_semantics.js';

const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.join(' '));
try {
  assert.equal(isLongDirection('多'), true);
  assert.equal(isShortDirection('空'), true);
  assert.equal(isLongDirection('空'), false);
  assert.equal(isShortDirection('多'), false);
  assert.equal(isShortDirection(' 空'), false);
  assert.equal(isLongDirection(' 空'), false);
  assert.equal(isLongDirection(undefined), false);
  assert.equal(errors.length, 2, 'each unknown value is reported once');
  assert.match(errors[0], /unknown trade direction " 空"/);
} finally {
  console.error = originalError;
}

for (const file of ['analytics.js', 'daily_pairs_view.js', 'daytrade_view.js', 'daytrade_replay_host.js', 'stock_stats_view.js']) {
  const source = readFileSync(new URL(`../ui/renderer/js/features/account/${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /direction\)?\s*===\s*"[多空]"|\["多",\s*"空"\]/, `${file} compares direction literals directly`);
}
console.log('renderer_account_direction_contract: ok');
