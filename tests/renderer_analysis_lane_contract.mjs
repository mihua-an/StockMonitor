import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startRealtimePage } from './support/realtime_page_harness.mjs';

// The renderer half of the analysis lane. The Rust half is covered by Market Runtime's own tests (native/market_runtime/tests);
// this executes the REAL extracted
// page functions so a change to them fails here rather than at a repack.
//
// Background: the analysis row (量變, 1m/3m/5m, the K columns, the model fields) and the monitor
// alert tape had no live transport at all. The `market.signals.*` / `signal.event` frames they
// used to ride belonged to the retired FastAPI websocket hub; this renderer's socket is Market
// Runtime, which never emitted them, so the branches had stopped running and the columns were
// refreshed by a 2-second /api/latest-signals poll -- ~83 Rust snapshot reads every two seconds
// to keep a projection warm. They now arrive as two channels on each symbol's own canonical view.

const source = readFileSync(new URL('../ui/renderer/js/features/realtime/canonical_view_owner.js', import.meta.url), 'utf8');

// --------------------------------------------------------------------------------------------
// Every product-list row must actually subscribe the two channels, or none of the rest matters.
// --------------------------------------------------------------------------------------------
{
  const { stockCanonicalViewSpec } = await import('../ui/renderer/js/market_data/stock_view_spec.js');
  const channels = stockCanonicalViewSpec('2330', '2026-09-25').channels;

  assert.ok(channels.includes('signals'), 'every row must subscribe the analysis signal channel');
  // The alerts are Market Runtime's 事件列表 tape (events.subscribe), not a per-row channel too.
  assert.ok(!channels.includes('events'), 'no per-row alert channel: the tape has one supply');
  // applyWatchPageToRealtime() builds every product-list row from this same spec, so subscribing
  // here is what makes the columns live for the whole page rather than the focused symbol only.
  for (const required of ['summary', 'trend', 'trades', 'orderbook']) {
    assert.ok(channels.includes(required), `${required} must not be dropped by the addition`);
  }
}

// --------------------------------------------------------------------------------------------
// The row router: shape one wire row for the application path that already existed.
// --------------------------------------------------------------------------------------------
{
  // The real page: the view owner subscribes the product's view, and its snapshot / signals.frame land in the row.
  const page = await startRealtimePage({ tradingDate: '2026-09-25' });
  const { appState } = await import('../ui/renderer/js/core/state.js');
  page.showProducts(['2330']);
  const spec = page.stockSpec('2330');
  const row = () => appState.signalsByCode.get('2330');

  page.serve(spec, { signals: {
    volume_change_pct: 12.5, chg_1m: 0.07, chg_3m: 0.2, chg_5m: 0.35,
    k_1m: 0.11, k_3m: null, ai_ready: 4, ai_total: 6, ai_champion: 'model-a',
    update_time: '09:31:00', authority: 'analysis_projection',
  } });
  const changes = row();
  assert.ok(changes, 'the snapshot applied the row');
  assert.deepEqual([...appState.signalsByCode.keys()], ['2330'], 'one row for the one product');

  assert.equal(
    changes.volume_change_pct_vs_baseline, 12.5,
    '量變 must be remapped: the column reader looks for the baseline-relative name, so leaving it '
    + 'under the wire name shows a dash next to a perfectly good number',
  );
  assert.equal(changes.chg_1m, 0.07);
  assert.equal(changes.chg_5m, 0.35);
  assert.equal(changes.ai_champion, 'model-a');
  // The stamp travels ON the row, and only on the row: each instrument is its own stream with no global arrival
  // order, so a batch-level stamp walked the displayed clock backwards. The clock is recomputed from the rows.
  assert.equal(changes.update_time, '09:31:00', "the producer's own stamp must reach the row");
  assert.ok(!('authority' in changes), 'transport provenance is not a displayable signal field');

  // A field the producer has never computed must not be invented as a value.
  assert.ok(changes.k_3m === undefined, 'no value is left out of the row, never a 0');

  // A signals.frame replaces the row; a delta that carries no signals block is not an empty row.
  page.delta(spec, 'signals.frame', { signals: { chg_1m: 0.5, update_time: '09:32:00' } });
  assert.equal(row().chg_1m, 0.5);
  page.delta(spec, 'signals.frame', {});
  assert.equal(row().chg_1m, 0.5, 'a missing signals block must not apply an empty row');
}

// --------------------------------------------------------------------------------------------
// The alert tape is not routed from the views any more: live_monitor_events.js reads Market Runtime's tape.
// --------------------------------------------------------------------------------------------
assert.ok(!/applyCanonicalMonitorEvents|events\.upsert|event\.frame/.test(source), 'no per-view alert route');

// --------------------------------------------------------------------------------------------
// The poll this replaced must be gone, and REST must keep only its proper jobs.
// --------------------------------------------------------------------------------------------
{
  assert.ok(
    !/startAnalysisSignalRefresh/.test(source),
    'the 2-second /api/latest-signals timer must not come back: that endpoint fans out to one '
    + 'Rust snapshot read per symbol, so the timer was doing ~83 reads every two seconds to keep '
    + 'a projection warm that now arrives as push',
  );
  assert.ok(!/ANALYSIS_SIGNAL_REFRESH_MS/.test(source));
  assert.ok(
    !/setInterval\([^)]*refreshLatestSignals/.test(source),
    'no timer may poll latest-signals; REST keeps first paint, reconnect recovery, history and an '
    + 'explicit user refresh',
  );
}

console.log('renderer analysis lane contract passed');
