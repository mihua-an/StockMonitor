import assert from 'node:assert/strict';

// What the view store does when a frame breaks a view's identity, and how its recoveries are recorded.
//
// Market Runtime binds a view to one partition and rebinds it itself -- with a fresh snapshot -- when the partition
// moves (server.rs view rebind, 43213ac). A delta or snapshot of another session identity is therefore a protocol
// fault of the producer side: it is refused, the view shows stale, and the fault is recorded once
// until the next baseline. The old heuristic (classify "rolled" vs "foreign", resync within a budget, escalate with a
// full subscribe) is gone. Legitimate recoveries -- a resync for a sequence gap, a re-subscribe after a timeout or an
// error, closing an orphan view -- are recorded remediations.
const { RealtimeViewStore } = await import('../ui/renderer/js/market_data/realtime_view_store.js');

function recorder() {
  const recorded = [];
  const remediation = {
    begin: (fields) => {
      recorded.push({ ...fields, outcome: 'started' });
      return { finish: (outcome, { attempt, detail } = {}) => recorded.push({ ...fields, outcome, attempt, detail }) };
    },
    emit: (fields) => recorded.push(fields),
  };
  return { recorded, remediation };
}

function boot(spec, options = {}) {
  const sent = [];
  const metrics = [];
  const { recorded, remediation } = recorder();
  const store = new RealtimeViewStore({
    send: (message) => { sent.push(message); return true; },
    onMetric: (payload) => metrics.push(payload),
    remediation,
    ...options,
  });
  store.onConnected();
  store.subscribe(spec, () => {});
  const subscribeMessage = sent.find((message) => message.type === 'view.subscribe');
  store.handleAccepted({ request_id: subscribeMessage.payload.request_id, subscription_id: 'sub-1', stream_id: 'stream-1', watermark: 0 });
  const key = store.entries.keys().next().value;
  return { store, sent, metrics, key, recorded };
}

const resyncs = (sent) => sent.filter((message) => message.type === 'view.resync');
const subscribes = (sent) => sent.filter((message) => message.type === 'view.subscribe');
const FUTU_SPEC = { source: 'futu', market: 'US', code: 'US.SPCX', session: 'FULL' };

function futuSnapshot(tradingDate = '2026-09-27', watermark = 10) {
  return {
    subscription_id: 'sub-1', stream_id: 'stream-1', watermark,
    session_key: { market: 'US', logical_code: 'US.SPCX', session: 'FULL', trading_date: tradingDate },
    summary: { current: 11.5 },
  };
}

function futuDelta(tradingDate, sequence) {
  return {
    subscription_id: 'sub-1', stream_id: 'stream-1', sequence,
    delta_type: 'summary.updated', payload: { current: 12.5 },
    session_key: { market: 'US', logical_code: 'US.SPCX', session: 'FULL', trading_date: tradingDate },
  };
}

// --- a delta of another identity is a protocol fault: refused, stale, recorded once, no guessing -----------------
{
  const { store, sent, key, recorded } = boot(FUTU_SPEC);
  assert.equal(store.handleSnapshot(futuSnapshot()), true);
  const subscribesBefore = subscribes(sent).length;
  for (let sequence = 11; sequence <= 30; sequence += 1) {
    assert.equal(store.handleDelta(futuDelta('2026-09-25', sequence)), false, 'the frame is refused');
  }
  const described = store.describe(key);
  assert.equal(described.last_reject_reason, 'WRONG_SESSION_IDENTITY');
  assert.equal(described.last_reject_field, 'trading_date');
  assert.equal(described.status, 'STALE', 'the view shows stale -- it is not being fed its own partition');
  assert.equal(store.snapshot(key).stale, true);
  assert.equal(store.snapshot(key).summary.current, 11.5, 'nothing of the foreign frames reaches the state');
  assert.equal(resyncs(sent).length, 0, 'no resync: the store does not guess what went wrong');
  assert.equal(subscribes(sent).length, subscribesBefore, 'no escalating re-subscribe');
  const faults = recorded.filter((event) => event.mechanismId === 'renderer.view_protocol_fault');
  assert.equal(faults.length, 1, 'recorded once per baseline, not once per refused delta');
  assert.equal(faults[0].triggerReason, 'wrong_session_identity');
  assert.equal(faults[0].outcome, 'suppressed');
  assert.equal(described.protocol_fault.field, 'trading_date');

  // Market Runtime's own rebind: a snapshot of the new partition (its own, lower sequence space) applies and clears it.
  assert.equal(store.handleSnapshot(futuSnapshot('2026-09-28', 3)), true);
  assert.equal(store.describe(key).protocol_fault, null);
  assert.equal(store.handleDelta(futuDelta('2026-09-28', 4)), true, 'the rebound partition flows from its own sequence');
  assert.equal(store.snapshot(key).stale, false);
}

// --- a snapshot that contradicts the spec is a protocol fault too ------------------------------------------------
{
  const PINNED = { source: 'shioaji', market: 'FUT', code: 'TXFR1', session: 'FULL', trading_date: '2026-09-25' };
  const { store, recorded } = boot(PINNED);
  assert.equal(store.handleSnapshot({
    subscription_id: 'sub-1', stream_id: 'stream-1', watermark: 10,
    session_key: { market: 'FUT', logical_code: 'TXFR1', session: 'FULL', trading_date: '2026-09-27' },
    summary: { current: 1 },
  }), false);
  assert.deepEqual(recorded.filter((e) => e.mechanismId === 'renderer.view_protocol_fault').map((e) => e.triggerReason),
    ['foreign_snapshot_identity']);
}

// --- an unsolicited snapshot of an OLDER session never re-baselines a wildcard view ---------
{
  const { store, key } = boot(FUTU_SPEC);
  assert.equal(store.handleSnapshot(futuSnapshot('2026-09-27', 10)), true);
  assert.equal(store.handleSnapshot(futuSnapshot('2026-09-25', 30)), false, 'an unsolicited older session is refused');
  assert.equal(store.describe(key).last_reject_reason, 'SUPERSEDED_SESSION_SNAPSHOT');
  assert.equal(store.snapshot(key).session_key.trading_date, '2026-09-27', 'the view stays on its newer session');
  assert.equal(store.handleSnapshot(futuSnapshot('2026-09-28', 1)), true, 'a rollover forward re-baselines');
  assert.equal(store.snapshot(key).session_key.trading_date, '2026-09-28');
}

// --- the gate is not weakened: an unstated field is still not a mismatch -----------------------
{
  const { store } = boot(FUTU_SPEC);
  store.handleSnapshot(futuSnapshot('2026-09-27', 10));
  const partial = futuDelta('2026-09-27', 11);
  delete partial.session_key.trading_date;
  delete partial.session_key.session;
  assert.equal(store.handleDelta(partial), true, 'a delta that simply does not restate session/date must still apply');
}

// --- a quiet view is not a broken view -----------------------------------------
{
  const { store, sent, key } = boot(FUTU_SPEC, { resyncCooldownMs: 3000 });
  store.handleSnapshot(futuSnapshot('2026-09-27', 10));
  const entry = store.entries.get(key);
  const base = Date.now();
  entry.last_snapshot_at = base - 600000;
  for (let sweep = 0; sweep < 10; sweep += 1) store.checkStaleness(base + sweep * 60000);
  assert.equal(resyncs(sent).length, 0, 'ten minutes of silence must not resync a LIVE view');
  assert.equal(store.describe(key).status, 'LIVE');
  assert.equal(store.snapshot(key).stale, false);
}

// --- a sequence gap is a recorded resync, ended by the snapshot that answers it -----------------
{
  const { store, sent, key, recorded } = boot(FUTU_SPEC, { resyncCooldownMs: 3000 });
  store.handleSnapshot(futuSnapshot('2026-09-27', 10));
  assert.equal(store.handleDelta(futuDelta('2026-09-27', 13)), false, 'a gap is refused');
  assert.equal(resyncs(sent).length, 1);
  const requestId = resyncs(sent).at(-1).payload.request_id;
  assert.equal(store.handleSnapshot({ ...futuSnapshot('2026-09-27', 20), request_id: requestId }), true,
    'the snapshot answering our own view.resync applies (routable by its request_id)');
  const rows = recorded.filter((event) => event.mechanismId === 'renderer.view_resync');
  assert.deepEqual(rows.map((event) => event.outcome), ['started', 'succeeded']);
  assert.equal(rows[0].triggerReason, 'sequence_gap');
  assert.equal(rows[0].identity.code, 'US.SPCX');
  assert.equal(rows[1].attempt, 1);
  // A request_id belonging to neither the live subscribe nor the pending resync is still refused.
  assert.equal(store.handleSnapshot({ ...futuSnapshot('2026-09-27', 30), request_id: 'view-someone-else' }), false);
  assert.equal(store.describe(key).last_reject_reason, 'SUPERSEDED_SNAPSHOT');
}

// --- an unanswered request is a recorded re-subscribe that cancels it; its late reply needs nothing --------------
{
  const sent = [];
  const { recorded, remediation } = recorder();
  const store = new RealtimeViewStore({ send: (m) => { sent.push(m); return true; }, remediation, subscriptionTimeoutMs: 10000 });
  store.onConnected();
  store.subscribe(FUTU_SPEC, () => {});
  const first = subscribes(sent).at(-1).payload.request_id;
  store.checkStaleness(Date.now() + 11000);
  store.checkStaleness(Date.now() + 22000);
  assert.equal(subscribes(sent).length, 3, 'two timeouts, two re-subscribes');
  assert.deepEqual(sent.filter((m) => m.type === 'view.unsubscribe').map((m) => m.payload.request_id),
    subscribes(sent).slice(0, 2).map((m) => m.payload.request_id), 'each timed-out request is cancelled by its id');
  // The first request's late acceptance and snapshot answer a view already cancelled.
  const unsubscribesBefore = sent.filter((m) => m.type === 'view.unsubscribe').length;
  assert.equal(store.handleAccepted({ request_id: first, subscription_id: 'sub-old', stream_id: 's' }), false);
  assert.equal(store.handleSnapshot({ ...futuSnapshot('2026-09-27', 1), subscription_id: 'sub-old', request_id: first }), false);
  assert.equal(sent.filter((m) => m.type === 'view.unsubscribe').length, unsubscribesBefore, 'nothing is closed twice');
  const current = subscribes(sent).at(-1).payload.request_id;
  store.handleAccepted({ request_id: current, subscription_id: 'sub-1', stream_id: 'stream-1' });
  assert.equal(store.handleSnapshot({ ...futuSnapshot('2026-09-27', 5), request_id: current }), true);
  const resubscribe = recorded.filter((e) => e.mechanismId === 'renderer.view_resubscribe');
  assert.deepEqual(resubscribe.map((e) => [e.outcome, e.triggerReason]), [['started', 'request_timeout'], ['succeeded', 'request_timeout']]);
  assert.equal(resubscribe[1].attempt, 2);
  assert.deepEqual(recorded.filter((e) => e.mechanismId !== 'renderer.view_resubscribe'), [], 'the cancelled replies record nothing');
}

// --- a view released before its subscription is accepted (10-27 15:01:19: 2303 let go of 169 ms after the subscribe):
// the cancel goes out at once by request id; the accept, the deltas and the snapshot that follow are known to answer a
// closed view -- one close, no remediation record, nothing refused as unknown ----------------------------------------
{
  const sent = [];
  const { recorded, remediation } = recorder();
  const store = new RealtimeViewStore({ send: (m) => { sent.push(m); return true; }, remediation });
  store.onConnected('conn-1');
  const release = store.subscribe(FUTU_SPEC, () => {});
  const request = subscribes(sent).at(-1).payload.request_id;
  release();
  assert.deepEqual(sent.at(-1), { type: 'view.unsubscribe', payload: { request_id: request } });
  assert.equal(store.handleAccepted({ request_id: request, subscription_id: 'sub-gone', stream_id: 's' }), false);
  assert.equal(store.handleDelta({ subscription_id: 'sub-gone', sequence: 1, stream_id: 's' }), false);
  assert.equal(store.handleSnapshot({ ...futuSnapshot('2026-09-27', 1), subscription_id: 'sub-gone', request_id: request }), false);
  assert.equal(sent.filter((m) => m.type === 'view.unsubscribe').length, 1, 'the request is closed once');
  assert.deepEqual(recorded, [], 'a known cancel is neither a remediation nor a fault');
  const stats = store.stats();
  assert.equal(stats.cancelled_reply_count, 1);
  assert.equal(stats.late_closed_delta_count, 1);
}

// --- a view released after its accept but before its snapshot: closed by its subscription, the snapshot is known ----
{
  const sent = [];
  const { recorded, remediation } = recorder();
  const store = new RealtimeViewStore({ send: (m) => { sent.push(m); return true; }, remediation });
  store.onConnected('conn-1');
  const release = store.subscribe(FUTU_SPEC, () => {});
  const request = subscribes(sent).at(-1).payload.request_id;
  store.handleAccepted({ request_id: request, subscription_id: 'sub-5', stream_id: 's' });
  release();
  assert.deepEqual(sent.at(-1), { type: 'view.unsubscribe', payload: { subscription_id: 'sub-5' } });
  assert.equal(store.handleSnapshot({ ...futuSnapshot('2026-09-27', 1), subscription_id: 'sub-5', request_id: request }), false);
  // A snapshot Market Runtime cut on its own before it read the unsubscribe is a late frame too.
  assert.equal(store.handleSnapshot({ ...futuSnapshot('2026-09-27', 2), subscription_id: 'sub-5', request_id: '' }), false);
  assert.equal(sent.filter((m) => m.type === 'view.unsubscribe').length, 1);
  assert.deepEqual(recorded, []);
  assert.equal(store.stats().late_closed_snapshot_count, 1);
}

// --- a reply to a request this window never had open is a recorded protocol fault, tied to its connection ---------
{
  const sent = [];
  const { recorded, remediation } = recorder();
  const store = new RealtimeViewStore({ send: (m) => { sent.push(m); return true; }, remediation });
  store.onConnected('conn-2');
  store.subscribe(FUTU_SPEC, () => {});
  assert.equal(store.handleAccepted({ request_id: 'view-never-sent', subscription_id: 'sub-late', stream_id: 's' }), false);
  assert.equal(sent.filter((m) => m.type === 'view.unsubscribe').length, 0, 'a view nobody here opened is not closed from here');
  const fault = recorded.find((e) => e.mechanismId === 'renderer.view_protocol_fault');
  assert.equal(fault.triggerReason, 'unknown_request_reply');
  assert.deepEqual([fault.detail.path, fault.detail.request_id], ['accepted', 'view-never-sent']);
  assert.deepEqual([fault.identity.subscription_id, fault.identity.connection_id], ['sub-late', 'conn-2']);
}

// --- a reconnect re-subscribe is one recorded recovery tied to its connection ---------------------------------------
{
  const sent = [];
  const { recorded, remediation } = recorder();
  const store = new RealtimeViewStore({ send: (m) => { sent.push(m); return true; }, remediation, subscriptionTimeoutMs: 10000 });
  store.onConnected('conn-1');
  store.subscribe(FUTU_SPEC, () => {});
  store.handleAccepted({ request_id: subscribes(sent).at(-1).payload.request_id, subscription_id: 'sub-1', stream_id: 'stream-1' });
  assert.equal(store.handleSnapshot(futuSnapshot('2026-09-27', 5)), true);
  store.onDisconnected();
  store.onConnected('conn-2');
  const first = subscribes(sent).at(-1).payload.request_id;
  store.checkStaleness(Date.now() + 11000);
  store.handleAccepted({ request_id: first, subscription_id: 'sub-late', stream_id: 's' });
  const current = subscribes(sent).at(-1).payload.request_id;
  store.handleAccepted({ request_id: current, subscription_id: 'sub-2', stream_id: 'stream-2' });
  assert.equal(store.handleSnapshot({ ...futuSnapshot("2026-09-27", 3), subscription_id: "sub-2", stream_id: "stream-2", request_id: current }), true);
  const rows = recorded.filter((e) => e.mechanismId === 'renderer.view_resubscribe');
  assert.deepEqual(rows.map((e) => [e.outcome, e.triggerReason]), [['started', 'reconnect'], ['succeeded', 'reconnect']]);
  assert.equal(rows[0].identity.connection_id, 'conn-2');
  assert.equal(rows[1].attempt, 2, 'the timeout re-subscribe is an attempt of the reconnect recovery');
  assert.ok(sent.some((m) => m.type === 'view.unsubscribe' && m.payload.request_id === first), 'the timed-out request is cancelled');
}

// --- a recovery still open when the view is released ends as abandoned -------------------------------------------
{
  const { store, recorded } = boot(FUTU_SPEC);
  store.handleSnapshot(futuSnapshot('2026-09-27', 10));
  store.handleDelta(futuDelta('2026-09-27', 12));
  for (const entry of store.entries.values()) for (const callback of [...entry.callbacks.keys()]) entry.callbacks.delete(callback);
  store.onDisconnected();
  assert.deepEqual(recorded.filter((e) => e.mechanismId === 'renderer.view_resync').map((e) => e.outcome), ['started', 'abandoned']);
}

// --- a consumer that throws is recorded once per fault streak, with its name ------------------------------
{
  const sent = [];
  const { recorded, remediation } = recorder();
  const store = new RealtimeViewStore({ send: (m) => { sent.push(m); return true; }, remediation });
  store.onConnected();
  let broken = true;
  store.subscribe(FUTU_SPEC, () => { if (broken) throw new Error('render failed'); }, { consumer: 'tickDetails' });
  store.handleAccepted({ request_id: subscribes(sent).at(-1).payload.request_id, subscription_id: 'sub-1', stream_id: 'stream-1' });
  store.handleSnapshot(futuSnapshot('2026-09-27', 10));
  store.handleDelta(futuDelta('2026-09-27', 11));
  store.handleDelta(futuDelta('2026-09-27', 12));
  let faults = recorded.filter((e) => e.mechanismId === 'renderer.view_consumer_fault');
  assert.equal(faults.length, 1, 'once per streak, not once per frame');
  assert.equal(faults[0].detail.consumer, 'tickDetails');
  assert.equal(faults[0].identity.code, 'US.SPCX');
  broken = false;
  store.handleDelta(futuDelta('2026-09-27', 13));
  broken = true;
  store.handleDelta(futuDelta('2026-09-27', 14));
  faults = recorded.filter((e) => e.mechanismId === 'renderer.view_consumer_fault');
  assert.equal(faults.length, 2, 'a new streak after a success is recorded again');
}

console.log('renderer delta identity contract passed (identity faults are recorded protocol faults; resync and re-subscribe are recorded recoveries; a view let go of before its reply is cancelled by request)');
