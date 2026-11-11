import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startRealtimePage } from './support/realtime_page_harness.mjs';
import { realtimeModuleSource, realtimePageSource } from './lib/realtime_sources.mjs';

// What the product list shows when an analysis row arrives, goes away, or was never there.
//
// There is deliberately NO 訊號數量 / 尚無訊號 / 全域更新時間 summary on the page. monitor.js used to
// write three ids -- signalCountValue, missingCountValue, updateTimeValue -- that existed in no
// markup at all, so the values were computed and thrown away; a packaged E2E found that, and an
// earlier version of this file missed it because its DOM stub answered for any id it was asked
// about. Those lookups are gone. Nothing here invents an element: the assertions go through the
// REAL row projection (mergeStockMarketSummary) and the REAL cell renderer
// (renderMinuteChangeCell), which is what the user actually reads.
//
// What still has to hold is the removal semantics, because a row that is no longer true must stop
// being displayed:
//
//   * `applyCanonicalSignalRow()` returned early whenever a view carried no `signals`, so an
//     authoritative snapshot saying "this instrument has no analysis row" was indistinguishable
//     from a delta that simply did not mention one;
//   * a session rollover cleared trades, trend, book and TAIEX but not the signal map;
//   * a product leaving the watch page kept its row, outliving the subscription that fed it.
//
// The page functions are executed from their real source; nothing is reimplemented.

const { mergeStockMarketSummary } = await import(
  '../ui/renderer/js/market_data/stock_market_summary.js');
const { renderMinuteChangeCell } = await import(
  '../ui/renderer/js/features/realtime/components/realtime_quote_table.js');
const { signalRowFields } = await import('../ui/renderer/js/features/realtime/signal_row.js');

const MONITOR = readFileSync(new URL('../ui/renderer/js/features/realtime/live_signals.js', import.meta.url), 'utf8');
// The 即時報價 page and its controllers; the analysis row's apply path is the view owner's.
const PAGE = realtimePageSource();
const OWNER = realtimeModuleSource('canonical_view_owner');
const MARKUP = readFileSync(new URL('../ui/renderer/pages/realtime.html', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------------------------
// 0 -- the dead summary lookups must not come back.
// ---------------------------------------------------------------------------------------------
// Matched as a real lookup, not as a mention: the removal is explained in prose right where it
// happened, and a raw substring match would keep tripping over its own explanation.
for (const id of ['signalCountValue', 'missingCountValue', 'updateTimeValue']) {
  assert.ok(
    !new RegExp(`\\$\\(\\s*["']${id}["']`).test(MONITOR),
    `live_signals.js must not look up #${id}: no document contains it, so the write went nowhere. `
    + 'Coverage is a diagnostics read now (getRealtimeSignalCoverage), and a product with no '
    + 'analysis row shows the dash in its own cells',
  );
  assert.ok(
    !new RegExp(`id="${id}"`).test(MARKUP),
    `and no summary element for #${id} may be added back silently`,
  );
}
assert.ok(
  /export function getRealtimeSignalCoverage/.test(MONITOR),
  'coverage must stay available on demand for diagnostics, just not as stored UI state',
);
assert.ok(
  /signal_coverage: getRealtimeSignalCoverage\(\)/.test(PAGE),
  'and it must have a real caller: an exported helper nobody reads is the same dead state again',
);
assert.ok(
  !/appState\.missingCodes/.test(MONITOR + PAGE),
  'missingCodes must not be persistent UI state any more',
);

// ---------------------------------------------------------------------------------------------
// The real row projection + the real cell renderer. `--` is what the cell renders for "no value".
// ---------------------------------------------------------------------------------------------
// The cell renders the ABSOLUTE value and carries direction in the class (price-up / price-down /
// price-flat), so the sign is only really asserted by reading both.
function cell(model) {
  const text = String(model.text).trim();
  const className = model.className || '';
  return { text, className, shown: `${className ? `${className} ` : ''}${text}`.trim() };
}

/** One product row exactly as realtimeMergedRow() builds it, then the 1m/3m/5m cells. */
function minuteCells({ watchItem = {}, productSummary = {}, liveSignal = {} } = {}) {
  const row = mergeStockMarketSummary({ watchItem, productSummary, liveSignal });
  return {
    row,
    display: Object.fromEntries([1, 3, 5].map((minutes) => {
      const key = `chg_${minutes}m`;
      return [key, cell(renderMinuteChangeCell(row[key] ?? row[`price_change_${minutes}m`]))];
    })),
  };
}

// 1 -- with an analysis row, 1m/3m/5m display the projection's values.
{
  const { display } = minuteCells({
    watchItem: { code: '2330' },
    liveSignal: { code: '2330', current: 100, chg_1m: 0.42, chg_3m: -1.25, chg_5m: 2 },
  });
  assert.equal(display.chg_1m.shown, 'price-up 0.42%', 'a pushed analysis row must reach the 1m cell');
  assert.equal(display.chg_3m.shown, 'price-down 1.25%',
    'a negative value is a value: the magnitude is the text and the direction is the class, so '
    + 'both have to be read to know the sign actually survived');
  assert.equal(display.chg_5m.shown, 'price-up 2.00%');
}

// 2 -- with no analysis row at all, the cells read "--".
{
  const { row, display } = minuteCells({ watchItem: { code: '2330' } });
  assert.equal(display.chg_1m.text, '--',
    'a product the projection has produced nothing for must read the dash, not 0 and not blank');
  assert.equal(display.chg_1m.className, '', 'and it must carry no direction colour');
  assert.equal(display.chg_3m.text, '--');
  assert.equal(display.chg_5m.text, '--');
  assert.equal(row.chg_1m, undefined, 'and no value may be invented on the row itself');
}

// 3 -- zero is a real value and must not be rendered as "no value".
{
  const { display } = minuteCells({
    watchItem: { code: '2330' },
    liveSignal: { code: '2330', current: 100, chg_1m: 0, chg_3m: 0, chg_5m: 0 },
  });
  assert.equal(display.chg_1m.shown, 'price-flat 0%',
    'flat and unknown are different facts and must not share a rendering');
}

// ---------------------------------------------------------------------------------------------
// Removal semantics, driven through the real page: the view owner subscribes the page's products, a view snapshot
// is the instrument's whole current state (authoritative), a signals.frame delta its newest row.
// ---------------------------------------------------------------------------------------------
const live = await startRealtimePage({ tradingDate: '2026-09-25' });
const { appState } = await import('../ui/renderer/js/core/state.js');
const { derivedMissingCodes, latestSignalStamp, replaceSignalRows } = await import('../ui/renderer/js/features/realtime/live_signals.js');
const served = new Set();

function boot({ pageCodes = [], visible = false } = {}) {
  appState.signalsByCode.clear();
  appState.watchlistItems = pageCodes.map((code) => ({ code }));
  live.showProducts(pageCodes);
  const show = (shown) => {
    live.pageState.setRealtimePageShown(shown);
    if (shown) live.pageState.viewResources.activate();
  };
  show(visible);
  const spec = (code) => live.stockSpec(code);
  // The view's first snapshot (no analysis row yet) is its baseline; later frames continue it.
  const baseline = (code) => { if (!served.has(code)) { served.add(code); live.serve(spec(code), {}); } };
  // The window's client metrics, as its diagnostics read them (market_data/realtime.js).
  const metricsSent = () => Object.values(globalThis.window.__stockMonitorClientMetrics())
    .filter((payload) => payload.name === 'first_meaningful_render');
  return {
    appState, derivedMissingCodes, latestSignalStamp, replaceSignalRows,
    /** A signals.frame (or, `authoritative`, a snapshot: the whole current state) for `code`. */
    applyCanonicalSignalRow(code, signals, { authoritative = false } = {}) {
      baseline(code);
      if (authoritative) live.serve(spec(code), signals ? { signals } : {});
      else live.delta(spec(code), 'signals.frame', signals === undefined ? {} : { signals });
    },
    setVisible: show,
    paint() { live.flush(); live.flush(); },
    framesQueued: () => [...live.live.timers.values()].filter((timer) => timer.delay === 0).length,
    reports: () => metricsSent().map(({ page }) => ({ page })),
    /** The 1m cell the product list would show for `code`, via the real projection + renderer. */
    cell(code, minutes = 1) {
      const signal = appState.signalsByCode.get(code) || {};
      return minuteCells({ watchItem: { code }, liveSignal: signal }).display[`chg_${minutes}m`].shown;
    },
  };
}

const codesOf = (page) => [...page.appState.signalsByCode.values()].map((row) => row.code).sort();

// 4 -- an authoritative snapshot with no signals REMOVES the row, and the cell falls back to "--".
{
  const page = boot({ pageCodes: ['2330', '2317'] });

  page.applyCanonicalSignalRow('2330', { chg_1m: 0.42, update_time: '09:31:00' });
  assert.deepEqual(codesOf(page), ['2330']);
  assert.equal(page.cell('2330'), 'price-up 0.42%');

  // The same code, in the new session, whose authoritative state carries no analysis row.
  page.applyCanonicalSignalRow('2330', undefined, { authoritative: true });

  assert.deepEqual(
    codesOf(page), [],
    'a snapshot is the complete current state: no signals means this instrument HAS no analysis '
    + 'row now',
  );
  assert.equal(
    page.cell('2330'), '--',
    'and the product row must fall back to the dash rather than the previous session 0.42%',
  );
}

// 5 -- a DELTA with no signals must NOT remove: absent means "no new value", not "cleared".
{
  const page = boot({ pageCodes: ['2330'] });
  page.applyCanonicalSignalRow('2330', { chg_1m: 0.42 });
  page.applyCanonicalSignalRow('2330', undefined);

  assert.deepEqual(
    codesOf(page), ['2330'],
    'a delta that does not mention signals is silence, not a retraction -- treating it as a '
    + 'removal would blank the column between every two signal frames',
  );
  assert.equal(page.cell('2330'), 'price-up 0.42%');
}

// 5b -- one authority, replace semantics: Market Runtime sends the instrument's whole signals object
// on every frame, so a value the next frame no longer carries is gone, not kept from the previous row.
{
  const page = boot({ pageCodes: ['2330'] });
  page.applyCanonicalSignalRow('2330', { chg_1m: 0.42, chg_3m: 1.5, volume_change_pct: 80, update_time: '09:31:00' });
  page.applyCanonicalSignalRow('2330', { chg_1m: 0.5, update_time: '09:32:00' });
  const row = page.appState.signalsByCode.get('2330');
  assert.equal(row.chg_1m, 0.5);
  assert.equal(row.chg_3m, undefined, 'a field the newest frame does not carry is not kept from the old row');
  assert.equal(row.volume_change_pct_vs_baseline, undefined);
  assert.equal(page.cell('2330', 3), '--');
  assert.equal(row.authority, undefined, 'provenance is not a row field');
}

// 6 -- a code that left the watch page must not keep a row behind it.
{
  const page = boot({ pageCodes: ['2330', '2317'] });
  page.applyCanonicalSignalRow('2330', { chg_1m: 0.42 });
  page.applyCanonicalSignalRow('2317', { chg_1m: 0.11 });

  // The page changed under it; realtime.js prunes departed codes through this same entry point.
  page.appState.watchlistItems = [{ code: '2317' }];
  page.replaceSignalRows({ removedCodes: ['2330'] });

  assert.deepEqual(codesOf(page), ['2317']);
  assert.equal(page.cell('2330'), '--', 'the departed product keeps no analysis value');
  assert.equal(page.cell('2317'), 'price-up 0.11%', 'and the surviving one is untouched');
}

// 7 -- coverage is computed from live state, so a stale row would corrupt it.
{
  const page = boot({ pageCodes: ['2330', '2317', '2454'] });
  page.applyCanonicalSignalRow('2330', { chg_1m: 0.42, update_time: '09:31:00' });
  assert.deepEqual(page.derivedMissingCodes(), ['2317', '2454']);

  page.applyCanonicalSignalRow('2330', null, { authoritative: true });
  assert.deepEqual(
    page.derivedMissingCodes(), ['2330', '2317', '2454'],
    'a row that should have been removed still counts as "has a row", so removal working is what '
    + 'keeps this number honest',
  );
}

// 8 -- each row keeps its own exchange stamp, which is what "not stale" is judged against.
{
  const page = boot({ pageCodes: ['2330', '2317'] });
  page.applyCanonicalSignalRow('2330', { chg_1m: 0.42, update_time: '09:31:00' });
  page.applyCanonicalSignalRow('2317', { chg_1m: 0.11, update_time: '09:32:30' });
  assert.equal(page.latestSignalStamp(), '09:32:30',
    'the newest EXCHANGE time held by an applied row; local arrival time is never a fallback');

  page.applyCanonicalSignalRow('2317', undefined, { authoritative: true });
  assert.equal(page.latestSignalStamp(), '09:31:00',
    'and it follows a removal down rather than reporting a freshness no row can account for');

  page.applyCanonicalSignalRow('2330', undefined, { authoritative: true });
  assert.equal(page.latestSignalStamp(), '',
    'with no rows left there is no stamp to report');

  // Only a well-formed exchange clock counts.
  page.replaceSignalRows({
    rows: [{ code: '2330', fields: { update_time: '2026-09-25 09:31:00' } }],
  });
  assert.equal(page.latestSignalStamp(), '',
    'a full datetime is not the exchange HH:MM:SS this represents');
}

// 9 -- first_meaningful_render means the user SAW numbers.
//
// It used to be reported unconditionally from the row's apply path, which also runs while the
// monitor is hidden and the row write has touched no DOM at all. That recorded "state exists"
// under a name claiming a render happened. Three conditions now: visible, a row actually changed,
// and a frame painted since.
{
  const page = boot({ pageCodes: ['2330', '2317'], visible: false });
  live.flush();

  page.applyCanonicalSignalRow('2330', { chg_1m: 0.42, update_time: '09:31:00' });
  assert.equal(page.framesQueued(), 0, 'a hidden page must not even queue a paint callback');
  page.paint();
  assert.deepEqual(page.reports(), [],
    'a signal applied to a background page is state, not a render');

  page.setVisible(true);
  page.applyCanonicalSignalRow('2317', { chg_1m: 0.11, update_time: '09:32:30' });
  assert.equal(page.reports().length, 0,
    'not until a frame has actually been painted -- the row write itself is not a paint');

  page.paint();
  assert.deepEqual(page.reports(), [{ page: 'realtime' }],
    'reported at the paint boundary after a visible row update');
}

console.log('renderer signal lifecycle contract passed');
