import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A subscribe the runtime refused outright answered with a top-level {"type":"error","request_id"}
// that the renderer ignored, so the view sat in loading until the ~55 s timeout.
// View.resync_required (slow-consumer overflow) was not dispatched at all, so a dropped-and-rebaselined
// view left no trace.
const { RealtimeViewStore } = await import('../ui/renderer/js/market_data/realtime_view_store.js');

function boot() {
  const sent = [];
  const store = new RealtimeViewStore({ send: (message) => { sent.push(message); return true; }, onMetric: () => {} });
  store.onConnected();
  const notes = [];
  store.subscribe({ source: 'shioaji', market: 'STK', code: '2330' }, (event) => notes.push(event));
  const subscribe = sent.find((message) => message.type === 'view.subscribe');
  return { store, notes, requestId: subscribe.payload.request_id, entry: () => store.entries.values().next().value };
}

{
  const { store, notes, requestId, entry } = boot();
  assert.equal(store.handleError({ request_id: requestId, error: 'symbol/code required' }), true);
  assert.equal(entry().status, 'ERROR');
  assert.equal(entry().last_error, 'symbol/code required');
  assert.ok(notes.some((event) => event?.type === 'error'));
}

{
  const { store, requestId, entry } = boot();
  store.handleAccepted({ request_id: requestId, subscription_id: 'sub-1', stream_id: 'stream-1', watermark: 0 });
  store.handleSnapshot({ subscription_id: 'sub-1', stream_id: 'stream-1', watermark: 5,
    session_key: { market: 'STK', logical_code: '2330', session: 'DAY', trading_date: '2026-10-02' }, summary: { current: 1000 } });
  assert.equal(entry().status, 'LIVE');
  assert.equal(store.handleServerResync({ reason: 'SLOW_CONSUMER', subscription_ids: ['sub-1'] }), 1);
  assert.equal(store.metrics.server_resync_count, 1);
  assert.equal(store.metrics.last_server_resync_reason, 'SLOW_CONSUMER');
  assert.equal(entry().status, 'RESYNCING');
  store.handleSnapshot({ subscription_id: 'sub-1', stream_id: 'stream-1', watermark: 9,
    session_key: { market: 'STK', logical_code: '2330', session: 'DAY', trading_date: '2026-10-02' }, summary: { current: 1005 } });
  assert.equal(entry().status, 'LIVE', 'the snapshot the runtime sends right after re-baselines the view');
}

// The page dispatch routes both message types to the store.
const PAGE = readFileSync(new URL('../ui/renderer/js/market_data/realtime.js', import.meta.url), 'utf8');
assert.match(PAGE, /type === "error" && message\.request_id\)\s*\{[^}]*handleError\(\{ request_id: message\.request_id/);
assert.match(PAGE, /type === "view\.resync_required"\)\s*\{\s*realtimeViewStore\.handleServerResync\(/);
console.log('renderer view runtime error/resync contract ok');
