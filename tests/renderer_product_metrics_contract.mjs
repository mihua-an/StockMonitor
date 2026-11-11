import assert from 'node:assert/strict';
import { mergeStockMarketSummary } from '../ui/renderer/js/market_data/stock_market_summary.js';

const merged = mergeStockMarketSummary({
  productSummary: {
    short_change_source: 'NATIVE_ROLLING_WINDOW', chg_1m: 2, chg_3m: 0,
    chg_5m: null, volume_baseline_source: 'shioaji_historical_ticks',
    baseline_volume: 100, volume_change_pct_vs_baseline: 50,
  },
  liveSignal: {
    chg_1m: 0, chg_3m: 3, chg_5m: 7, change_5m: 7,
    baseline_volume: null, volume_change_pct_vs_baseline: null,
  },
});
assert.equal(merged.chg_1m, 2);
assert.equal(merged.chg_3m, 0);
assert.equal(merged.chg_5m, null);
assert.equal(merged.change_5m, null);
assert.equal(merged.baseline_volume, 100);
assert.equal(merged.volume_change_pct_vs_baseline, 50);
console.log('renderer product metrics contract passed');
