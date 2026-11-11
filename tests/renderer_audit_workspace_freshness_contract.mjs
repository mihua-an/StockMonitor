import assert from 'node:assert/strict';

const timers = new Map();
let nextTimer = 1;
globalThis.setTimeout = (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.requestAnimationFrame = (fn) => globalThis.setTimeout(fn, 0);
globalThis.cancelAnimationFrame = globalThis.clearTimeout;
function fireTimer(delay) {
  const match = [...timers].find(([, entry]) => entry.delay === delay);
  assert.ok(match, `expected a scheduled ${delay}ms timer`);
  const [id, entry] = match;
  timers.delete(id);
  entry.fn();
}

const { WorkspaceColumn } = await import('../ui/renderer/js/features/workspace/workspace_column_runtime.js');
const { RealtimeViewStore } = await import('../ui/renderer/js/market_data/realtime_view_store.js');
const { MarketDataGateway } = await import('../ui/renderer/js/market_data/market_data_gateway.js');
const { createDashboardContext } = await import('../ui/renderer/js/core/dashboard_context.js');

const wire = [], requests = [], invalidations = [];
const raw = new RealtimeViewStore({ send: m => { wire.push(m); return true; } });
const gateway = new MarketDataGateway({ subscribeView: raw.subscribe.bind(raw), getSnapshot: raw.snapshot.bind(raw) });
raw.onConnected();
const context = createDashboardContext({ id: 'audit:2330', mode: 'live', capabilities: ['tick', 'bidask', 'trend'] });
const originalInvalidate = context.dataSource.invalidate.bind(context.dataSource);
context.dataSource.invalidate = name => { invalidations.push(name); originalInvalidate(name); };
const column = new WorkspaceColumn({ code: '2330', tradingDate: '2026-09-19', gateway, context,
  apiGet: path => new Promise(resolve => requests.push({ path, resolve })),
  benchmarkSource: { ensure: async () => {}, points: () => [], referencePrice: () => null } });
function hydrate(date, id) {
  const request = wire.filter(m => m.type === 'view.subscribe').at(-1).payload;
  raw.handleAccepted({ request_id: request.request_id, subscription_id: id, stream_id: id, watermark: 0 });
  raw.handleSnapshot({ request_id: request.request_id, subscription_id: id, stream_id: id,
    session_key: { market: 'STK', logical_code: '2330', session: 'DAY', trading_date: date }, watermark: 0,
    summary: { current: 100 }, trend: [], trades: [], orderbook: {} });
}
// Before its first snapshot the column's view has no state: a control event is what the frame shows.
column.handleEvent({ type: 'error', error: 'refused before snapshot', entry: { status: 'ERROR', presentation_state: 'error' } });
assert.equal(column.buildTrendViewModel().viewError, 'refused before snapshot', 'an error before the first snapshot is shown');
assert.equal(column.buildOrderbookViewModel().presentationState, 'error');
hydrate('2026-09-19', 'old');
assert.equal(column.buildTrendViewModel().viewError, null, 'the snapshot replaces the control state');
invalidations.length = 0;
raw.onDisconnected();
// RealtimeViewStore updates state without a view callback on disconnect;
// workspace_view's realtime connection batch drives this invalidation.
column.refreshFreshness();
assert.equal(column.buildTrendViewModel().stale, true, 'R03: disconnected trend must reflect canonical freshness');
assert.equal(column.buildTickDetailsViewModel().stale, true);
assert.ok(invalidations.includes('trendChart') && invalidations.includes('tickDetails') && invalidations.includes('orderbook'));
raw.onConnected(); hydrate('2026-09-19', 'again');
raw.handleDeltaBatch({ items: [{ subscription_id: 'again', stream_id: 'again', sequence: 9,
  session_key: { market: 'STK', logical_code: '2330', session: 'DAY', trading_date: '2026-09-19' }, delta_type: 'summary.updated', payload: { current: 999 } }] });
assert.equal(column.buildTrendViewModel().resyncing, true);
raw.handleError({ subscription_id: 'again', error: 'audit subscription failure' });
assert.equal(column.buildTickDetailsViewModel().viewError, 'audit subscription failure');

// The constructor took the real page-1 hot path: page 1 is the WS's, with ONE count read and no timer
// (never a 15-second metadata re-read).
assert.equal(requests.length, 1, 'hot page 1 reads the page count once');
assert.equal([...timers.values()].filter((t) => t.delay === 15000).length, 0, 'no metadata poll');
assert.match(requests.at(-1).path, /trading_date=2026-09-19/, 'pre-rollover background metadata refresh must be scoped to the old day');
const staleRequest = requests.at(-1);

column.setSession({ tradingDate: '2026-09-20' });
assert.equal(column.spec.trading_date, '2026-09-20');
assert.equal(column.buildTrendViewModel().currentPrice, null);

// setSession() calls pager.reset(), which issues a new generation. A
// still-in-flight background refresh for the OLD day resolving AFTER
// rollover must be discarded, not applied to the new session.
staleRequest.resolve({ ok: true, rows: [{ price: 999 }], total_rows: 999, total_pages: 10 });
for (let i = 0; i < 8; i++) await Promise.resolve();
assert.equal(column.pager.state.totalCount, 0, 'old HTTP response cannot restore old session');
// The full rollover production chain: setSession() called pager.reset(), then
// R03 full production chain: setSession() called pager.reset(), then
// pager.load({latest:true}) took the hot path and read the NEW day's count.
assert.equal(requests.length, 2, 'the new day opens with its own count read, at once');
assert.match(requests.at(-1).path, /trading_date=2026-09-20/, 'R03: metadata refresh after rollover must use the new trading day');
requests.at(-1).resolve({ ok: true, rows: [], total_rows: 5, total_pages: 1 });
for (let i = 0; i < 8; i++) await Promise.resolve();
assert.equal(column.pager.state.totalCount, 5, 'fresh post-rollover metadata refresh must apply internally without sending pagination data to the UI');

hydrate('2026-09-20', 'new');
assert.equal(column.buildTrendViewModel().stale, false);
assert.equal(column.buildTrendViewModel().viewError, null);
column.dispose();
console.log('workspace audit freshness contract passed (disconnect, gap, error, rollover, late response, recovery)');
