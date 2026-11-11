import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startRealtimePage } from './support/realtime_page_harness.mjs';
import {
  mergeCanonicalStockSummary,
  mergeStockMarketSummary,
} from '../ui/renderer/js/market_data/stock_market_summary.js';

// Item 12: /api/latest-signals no longer backfills market fields and no longer computes 量變.
// (1) The product row's market fields must still arrive from the canonical Market Runtime view.
// (2) 量變 has one producer (AnalysisSignalProducer); the renderer shows its number, never a local
//     recomputation, and a named minute with no baseline clears the previous minute's number.

// --------------------------------------------------------------------------------------------
// (1) Market fields: canonical WS summary -> productMarketSummaries -> product row.
// --------------------------------------------------------------------------------------------
{
  // The wire `summary` block, exactly as summary_wire() emits it.
  const canonical = mergeCanonicalStockSummary({}, {
    current: 101, prev_close: 100, open: 100.5, high: 102, low: 99.5,
    total_volume: 12345, limit_up: 110, limit_down: 90,
  }, '2330');
  // An analysis row as the producer now stores it: no market backfill at all.
  const analysisRow = {
    code: '2330', chg_1m: 0.5, volume_compare_minute: 629,
    volume_change_pct_vs_baseline: 114, update_time: '10:30:20',
  };
  const row = mergeStockMarketSummary({ productSummary: canonical, liveSignal: analysisRow });

  assert.equal(row.total_volume, 12345, 'total_volume must come from the canonical view');
  assert.equal(row.day_high, 102);
  assert.equal(row.day_low, 99.5);
  assert.equal(row.limit_up, 110, 'limit_up must survive the join for 漲跌停 colouring');
  assert.equal(row.limit_down, 90);
  assert.equal(row.volume_change_pct_vs_baseline, 114);
  assert.equal(row.chg_1m, 0.5);
}

// --------------------------------------------------------------------------------------------
// (2a) The 量變 column shows the producer's percentage, never a local recomputation.
// --------------------------------------------------------------------------------------------
{
  globalThis.window ??= { desktopAPI: {}, addEventListener() {}, removeEventListener() {} };
  const { resolveRealtimeVolumeChangePct: resolve } = await import(
    '../ui/renderer/js/features/realtime/components/realtime_quote_table.js');

  // A first-paint REST row carrying the day's total and a one-minute baseline: dividing them was
  // the old fallback, and it produced numbers in the tens of thousands of percent.
  assert.equal(resolve({ total_volume: 50000, baseline_volume: 50, volume_change_pct_vs_baseline: 114 }), 114);
  // A stale baseline_volume must not outvote a fresher pushed percentage.
  assert.equal(resolve({ baseline_volume: 50, volume_change_pct_vs_baseline: -20 }), -20);
  // No baseline is a dash, not 0.0%.
  assert.equal(resolve({ total_volume: 50000, baseline_volume: 50, volume_change_pct_vs_baseline: null }), null);
  assert.equal(resolve({}), null);
}

// --------------------------------------------------------------------------------------------
// (2b) A signals delta that names the minute clears a stale percentage.
// --------------------------------------------------------------------------------------------
{
  // The real page: the product's view, its signals.frame deltas, and the row they leave.
  const page = await startRealtimePage({ tradingDate: '2026-09-25' });
  const { appState } = await import('../ui/renderer/js/core/state.js');
  page.showProducts(['2330']);
  const spec = page.stockSpec('2330');
  page.serve(spec, {});
  const run = (signals) => {
    page.delta(spec, 'signals.frame', { signals });
    const { code: _code, ...fields } = appState.signalsByCode.get('2330');
    return fields;
  };

  const withValue = run({ volume_change_pct: 114, volume_compare_minute: 629 });
  assert.equal(withValue.volume_change_pct_vs_baseline, 114);
  assert.equal(withValue.volume_compare_minute, 629, 'the minute rides on the row, as over REST');

  const cleared = run({ volume_change_pct: null, volume_compare_minute: 630 });
  assert.ok('volume_change_pct_vs_baseline' in cleared,
    '10:30 has no baseline: the delta must carry an explicit null, or 10:29\'s number stays up');
  assert.equal(cleared.volume_change_pct_vs_baseline, null);

  // A row that does not name the minute has no 量變 at all (the row is replaced, so nothing older survives).
  const partial = run({ chg_1m: 0.3, volume_change_pct: null });
  assert.ok(!('volume_change_pct_vs_baseline' in partial));

  // The Futu rows go through the same projection.
  const adapter = readFileSync(new URL('../ui/renderer/js/features/realtime/moomoo_view_adapter.js', import.meta.url), 'utf8');
  assert.match(adapter, /signalRowFields\(state\?\.signals\)/);
  assert.ok(!/volume_change_pct:/.test(adapter), 'no second copy of the signals field projection');
}

console.log('renderer volume change single authority contract passed');
